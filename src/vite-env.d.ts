// Plain *.wgsl imports (used by src/ and handled by tsup's loader)
// are declared in wgsl.d.ts.
// The ?raw suffix below is Vite-specific, used by test files run via vitest/vite.
declare module '*.wgsl?raw' {
  const content: string;
  export default content;
}
