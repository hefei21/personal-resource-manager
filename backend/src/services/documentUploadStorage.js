import { getDocumentStorageRuntime } from './documentStorageRuntime.js'

export class DocumentUploadStorage {
  constructor({ runtimeProvider = getDocumentStorageRuntime } = {}) {
    if (typeof runtimeProvider !== 'function') throw new TypeError('runtimeProvider must be a function')
    this.runtimeProvider = runtimeProvider
  }

  _handleFile(req, file, callback) {
    let runtime
    try { runtime = this.runtimeProvider() } catch (error) {
      callback(error)
      return
    }
    runtime.storageService.stageFromStream(file.stream).then((staged) => {
      callback(null, {
        stagingToken: staged.token,
        contentSha256: staged.sha256,
        contentBytes: staged.bytes,
        originalName: file.originalname
      })
    }, callback)
  }

  _removeFile(req, file, callback) {
    if (!file?.stagingToken) {
      callback(null)
      return
    }
    try {
      this.runtimeProvider().storageService.discardStaged(file.stagingToken)
      callback(null)
    } catch (error) {
      callback(error)
    }
  }
}
