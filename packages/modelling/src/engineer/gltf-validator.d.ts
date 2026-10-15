/** The parts of the Khronos glTF validator (npm `gltf-validator`, no types of its own) we use. */
declare module 'gltf-validator' {
  export interface ValidationMessage {
    code: string;
    message: string;
    /** 0 error, 1 warning, 2 information, 3 hint. */
    severity: number;
    pointer?: string;
  }
  export interface ValidationReport {
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      numHints: number;
      messages: ValidationMessage[];
    };
  }
  export function validateBytes(
    data: Uint8Array,
    options?: {
      uri?: string;
      format?: 'glb' | 'gltf';
      maxIssues?: number;
      writeTimestamp?: boolean;
    },
  ): Promise<ValidationReport>;
  export function version(): string;
}
