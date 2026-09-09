import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Emits a self contained server bundle so the runtime image needs no
  // node_modules and no toolchain. Without this the Dockerfile copies an empty
  // .next/standalone and the container starts with nothing to run.
  output: 'standalone',
  // Set explicitly rather than relying on tsconfig paths, which webpack did not
  // pick up here.
  webpack: (config) => {
    config.resolve.alias['@'] = here
    return config
  },
}
