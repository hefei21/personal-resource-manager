export function isReadOnlyRepository(repository) {
  return repository?.readOnly === true || repository?.type === 'git_nas'
}

export function repositorySourceLabel(repository) {
  return isReadOnlyRepository(repository) ? 'NAS 只读 Git' : '受管 Git'
}
