// Values provided by the shared integration global setup (apps/server/test/integration/global-setup.ts).
declare module 'vitest' {
  export interface ProvidedContext {
    anvilUrl: string;
  }
}
export {};
