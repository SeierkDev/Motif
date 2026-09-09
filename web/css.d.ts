// TypeScript 6 does not infer a type for CSS side-effect imports, and Next
// rewrites next-env.d.ts on every build, so this has to live in its own file.
declare module '*.css'
