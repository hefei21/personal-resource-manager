"""Explicitly started loopback-only reranker. No model downloads or NAS access."""
import argparse
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import socket
from http.server import BaseHTTPRequestHandler, HTTPServer

PROFILE = json.loads(Path(__file__).with_name('profile.json').read_text(encoding='utf-8'))
MAX_BYTES = 2 * 1024 * 1024
MAX_ITEMS = 50
MAX_TOKENS = 2048
BATCH = 8
IDENTITY = {
    'provider': 'prmanager-pytorch', 'modelId': PROFILE['modelId'],
    'modelRevision': PROFILE['revision'], 'dimensions': 1, 'inputLimit': MAX_TOKENS,
    'configHash': hashlib.sha256(json.dumps([
        PROFILE['revision'], PROFILE['instruction'], 'float16', 'eager', MAX_TOKENS,
        BATCH, 'yes-minus-no', 'reject-overlength'
    ], separators=(',', ':')).encode()).hexdigest()
}


class InvalidInput(ValueError):
    pass


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise InvalidInput('duplicate_key')
        value[key] = item
    return value


def validate_request(raw):
    if len(raw) > MAX_BYTES:
        raise InvalidInput('input_too_large')
    try:
        data = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
    except (ValueError, UnicodeError):
        raise InvalidInput('invalid_json') from None
    if not isinstance(data, dict) or set(data) != {'query', 'texts', 'raw_scores', 'model'}:
        raise InvalidInput('invalid_fields')
    if data['model'] != IDENTITY or any(type(data['model'][key]) is not type(value) for key, value in IDENTITY.items()) or data['raw_scores'] is not True:
        raise InvalidInput('identity_mismatch')
    texts = data['texts']
    if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_ITEMS:
        raise InvalidInput('invalid_count')
    for text in [data['query'], *texts]:
        if not isinstance(text, str) or not text.strip() or any(ord(c) < 32 and c not in '\n\r\t' or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in text):
            raise InvalidInput('invalid_text')
    if len(data['query'].encode('utf-8')) > 65536:
        raise InvalidInput('query_too_large')
    return data


def verify_files(directory):
    directory = Path(directory).resolve(strict=True)
    for name, expected in PROFILE['files'].items():
        target = directory / name
        if target.is_symlink() or target.resolve(strict=True).parent != directory:
            raise ValueError('model_path_invalid')
        with target.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                raise ValueError('model_hash_mismatch')
    return directory


class Scorer:
    def __init__(self, directory):
        directory = verify_files(directory)
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        import torch
        from transformers import AutoTokenizer, AutoModelForCausalLM
        from importlib.metadata import version
        if version('torch') != '2.13.0+cu130' or version('transformers') != '5.14.1':
            raise RuntimeError('runtime_version_mismatch')
        if not torch.cuda.is_available():
            raise RuntimeError('cuda_unavailable')
        self.torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False, padding_side='left')
        self.model = AutoModelForCausalLM.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False, dtype=torch.float16, attn_implementation='eager').cuda().eval()
        prefix = '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
        suffix = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
        self.pre = self.tokenizer.encode(prefix, add_special_tokens=False)
        self.post = self.tokenizer.encode(suffix, add_special_tokens=False)
        self.yes = self.tokenizer.convert_tokens_to_ids('yes')
        self.no = self.tokenizer.convert_tokens_to_ids('no')
        if self.yes == self.no or self.tokenizer.unk_token_id in (self.yes, self.no):
            raise RuntimeError('tokenizer_invalid')

    def __call__(self, query, texts):
        ids = [self.pre + self.tokenizer.encode(
            f'<Instruct>: {PROFILE["instruction"]}\n<Query>: {query}\n<Document>: {text}',
            add_special_tokens=False) + self.post for text in texts]
        # Fail the entire request; never silently change evidence by truncation.
        if any(len(row) > MAX_TOKENS for row in ids):
            raise InvalidInput('token_limit')
        scores = []
        for start in range(0, len(ids), BATCH):
            inputs = self.tokenizer.pad({'input_ids': ids[start:start+BATCH]}, padding=True, return_tensors='pt').to('cuda')
            with self.torch.inference_mode():
                logits = self.model(**inputs, use_cache=False, logits_to_keep=1).logits[:, -1, :].float()
                scores.extend((logits[:, self.yes] - logits[:, self.no]).cpu().tolist())
        return scores


def valid_token(token):
    return isinstance(token, str) and 32 <= len(token) <= 4096 and all(33 <= ord(c) <= 126 for c in token)


class Server(HTTPServer):
    # One bounded request at a time: no GPU concurrency or unbounded thread pool.
    request_queue_size = 1
    allow_reuse_address = False

    def __init__(self, port, token, scorer):
        if not valid_token(token):
            raise ValueError('token_required')
        self.token, self.scorer = token, scorer
        super().__init__(('127.0.0.1', port), Handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address

    def handle_error(self, request, client_address):
        # Do not log request bodies, credentials or exception representations.
        pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, payload):
        body = json.dumps(payload, separators=(',', ':'), allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        self.wfile.write(body)

    def allowed(self):
        host = f'127.0.0.1:{self.server.server_port}'
        if self.headers.get_all('Host') != [host] or self.headers.get('Origin') is not None:
            self.reply(403, {'error': 'origin_rejected'})
            return False
        auth = self.headers.get_all('Authorization') or []
        if len(auth) != 1 or not hmac.compare_digest(auth[0].encode(), ('Bearer ' + self.server.token).encode()):
            self.reply(401, {'error': 'unauthorized'})
            return False
        return True

    def do_GET(self):
        if not self.allowed():
            return
        if self.path == '/info':
            self.reply(200, {'model_type': 'reranker', 'model': IDENTITY})
        elif self.path == '/health':
            self.reply(200, {'ready': True})
        else:
            self.reply(404, {'error': 'not_found'})

    def do_POST(self):
        if not self.allowed():
            return
        if self.path != '/rerank':
            return self.reply(404, {'error': 'not_found'})
        lengths = self.headers.get_all('Content-Length') or []
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit() or self.headers.get('Transfer-Encoding'):
            return self.reply(400, {'error': 'invalid_length'})
        length = int(lengths[0])
        if not 0 < length <= MAX_BYTES:
            return self.reply(413, {'error': 'input_too_large'})
        if self.headers.get_content_type() != 'application/json':
            return self.reply(415, {'error': 'content_type'})
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise InvalidInput('incomplete_body')
            data = validate_request(raw)
            scores = self.server.scorer(data['query'], data['texts'])
            if len(scores) != len(data['texts']) or any(type(s) not in (int, float) or not math.isfinite(s) for s in scores):
                raise RuntimeError('invalid_scores')
            self.reply(200, [{'index': i, 'score': s} for i, s in enumerate(scores)])
        except InvalidInput:
            self.reply(422, {'error': 'input_rejected'})
        except (TimeoutError, socket.timeout):
            self.close_connection = True
        except Exception:
            self.reply(503, {'error': 'scoring_unavailable'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--port', type=int, default=19091)
    args = parser.parse_args()
    token = os.environ.get('PC_WORKER_RERANKER_API_KEY', '')
    if not 1 <= args.port <= 65535 or not valid_token(token):
        parser.error('valid port and PC_WORKER_RERANKER_API_KEY required')
    with Server(args.port, token, Scorer(args.model_dir)) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
