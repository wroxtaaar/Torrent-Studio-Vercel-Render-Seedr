declare module 'bencode' {
  export function decode(data: Buffer | Uint8Array | string, encoding?: string): any;
  export function encode(data: any): Buffer;
  export function byteLength(data: any): number;
  const bencode: {
    decode: typeof decode;
    encode: typeof encode;
    byteLength: typeof byteLength;
  };
  export default bencode;
}
