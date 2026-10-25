export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

export class StorageError extends Error {
  override readonly name = "StorageError";
}
