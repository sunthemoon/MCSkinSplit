declare module "pngjs/browser.js" {
  interface PngReadResult {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8Array;
  }

  interface PngWriteInput {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8Array;
  }

  interface PngWriteOptions {
    readonly colorType?: number;
    readonly inputColorType?: number;
    readonly inputHasAlpha?: boolean;
    readonly deflateLevel?: number;
  }

  export const PNG: {
    readonly sync: {
      read(input: Uint8Array): PngReadResult;
      write(input: PngWriteInput, options?: PngWriteOptions): Uint8Array;
    };
  };
}
