const SESSION_IMPORT_FORMAT = "dsh-session-teleport/import-v1";
class TeleportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "TeleportError";
  }
  code;
}
export {
  SESSION_IMPORT_FORMAT,
  TeleportError
};
//# sourceMappingURL=types.js.map
