/** The protocol fields of a save request, as the widget or the worker received them. */
export interface SaveProtocolRequest {
  save_protocol?: unknown;
  required_capabilities?: unknown;
  operation_id?: unknown;
}

/** The refusal of a save that needs a protocol or capability this build lacks; nothing was saved. */
export type SaveProtocolRejection = {
  ok: false;
  code: "incompatible_protocol";
  outcome: "not_committed";
  terminal_rejected: true;
  /** The request's own operation id, when it named one. */
  operation_id?: string;
  error: string;
};

declare global {
  var MineSaveProtocol: Readonly<{
    /** The refusal of `request`, or `null` when this build can carry it out. */
    validate(request: SaveProtocolRequest): SaveProtocolRejection | null;
    /** The capabilities every save of this build requires. */
    required: readonly string[];
  }>;
}
