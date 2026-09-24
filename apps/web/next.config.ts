import type { NextConfig } from 'next';

const config: NextConfig = {
	reactStrictMode: true,
	// Keep a local production check separate from an already-running development server.
	distDir: process.env.NEXT_DIST_DIR ?? '.next',
	transpilePackages: ['@captain/ui'],
	poweredByHeader: false
};
export default config;
