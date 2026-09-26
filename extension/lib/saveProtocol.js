// One baseline validator shared by the widget and browser executor.
(function (root) {
  "use strict";
  const required = Object.freeze(["save_operation_v1", "operation_lookup_v1"]);
  function validate(request) {
    const capabilities = request.required_capabilities;
    if ((request.save_protocol !== undefined && request.save_protocol !== 1)
        || (capabilities !== undefined && (!Array.isArray(capabilities)
          || !capabilities.every(value => typeof value === "string" && required.includes(value))))) {
      return { ok: false, code: "incompatible_protocol", outcome: "not_committed", terminal_rejected: true,
        ...(typeof request.operation_id === "string" ? { operation_id: request.operation_id } : {}),
        error: "This save requires an unsupported protocol or capability. Its draft is preserved." };
    }
    return null;
  }
  root.MineSaveProtocol = Object.freeze({ validate, required });
})(globalThis);
