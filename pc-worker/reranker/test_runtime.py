import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from runtime import IDENTITY, InvalidInput, MAX_BYTES, Scorer, Server, validate_request, verify_files

TOKEN = 'test-only-not-a-real-credential-0000'


def body(**changes):
    return json.dumps(dict(query='问题', texts=['first', 'second'], raw_scores=True, model=IDENTITY, **changes)).encode()


class RuntimeTests(unittest.TestCase):
    def test_input_contract(self):
        good = json.loads(body())
        self.assertEqual(validate_request(body())['query'], '问题')
        for update in [dict(texts=[]), dict(texts=['x']*51), dict(query=''), dict(query='x\0'),
                       dict(model={}), dict(raw_scores=False), dict(texts=[3]), dict(extra=True),
                       dict(query='\ud800'), dict(texts=['\udfff']), dict(model={**IDENTITY, 'dimensions': True})]:
            with self.subTest(update=update), self.assertRaises(InvalidInput):
                validate_request(json.dumps({**good, **update}).encode())
        for raw in [b'{"query":"a","query":"b"}', b'\xff', b'x'*(MAX_BYTES+1)]:
            with self.assertRaises(InvalidInput):
                validate_request(raw)
        good['texts'] = ['x']*50
        self.assertEqual(len(validate_request(json.dumps(good).encode())['texts']), 50)

    def test_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'model.safetensors').write_bytes(b'wrong')
            with self.assertRaisesRegex(ValueError, 'hash_mismatch'):
                verify_files(directory)

    def test_overlength_rejected_before_model(self):
        scorer = Scorer.__new__(Scorer)
        scorer.pre, scorer.post = [], []
        class Tokenizer:
            def encode(self, *args, **kwargs):
                return [1]*2049
        scorer.tokenizer = Tokenizer()
        with self.assertRaisesRegex(InvalidInput, 'token_limit'):
            scorer('q', ['text'])

    def setUp(self):
        self.calls = []
        def score(q, texts):
            self.calls.append((q, texts))
            return [0.1]*len(texts)
        self.server = Server(0, TOKEN, score)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    def request(self, path='/rerank', data=None, headers=None, method='POST'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        try:
            connection.request(method, path, body() if data is None and method == 'POST' else data,
                               headers={'Authorization':'Bearer '+TOKEN, 'Content-Type':'application/json', **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_real_http_and_identity(self):
        status, result = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(result, [{'index':0,'score':0.1},{'index':1,'score':0.1}])
        self.assertEqual(self.request('/info', method='GET')[1]['model'], IDENTITY)
        self.assertEqual(self.request('/health', method='GET')[0], 200)
        self.assertEqual(self.request('/other')[0], 404)

    def test_rejects_browser_and_unauthenticated_requests(self):
        for headers, status in [({'Authorization':'Bearer wrong'},401), ({'Origin':'https://evil.test'},403),
                                ({'Host':'evil.test'},403), ({'Content-Type':'text/plain'},415),
                                ({'Content-Length':str(MAX_BYTES+1)},413), ({'Transfer-Encoding':'chunked'},400)]:
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers=headers)[0], status)
        self.assertEqual(self.calls, [])

    def test_sanitizes_failures_and_recovers(self):
        with patch.object(self.server, 'scorer', side_effect=RuntimeError('secret document')):
            self.assertEqual(self.request(), (503, {'error':'scoring_unavailable'}))
        with patch.object(self.server, 'scorer', return_value=[float('nan'), 1]):
            self.assertEqual(self.request()[0], 503)
        self.assertEqual(self.request()[0], 200)

    def test_token_mandatory(self):
        with self.assertRaises(ValueError):
            Server(0, 'short', lambda q,t: [])


if __name__ == '__main__':
    unittest.main()
