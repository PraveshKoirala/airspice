/**
 * Minimal ambient declaration for `TextEncoder`, which is a standard global in
 * browsers, Web Workers, and Node (>=11). We declare only the one method we use
 * rather than pulling in the DOM lib (which would violate the epic's "zero DOM
 * dependency" rule) or @types/node (which would tie the runtime types to Node).
 */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
