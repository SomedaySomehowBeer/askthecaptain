import type { NextConfig } from 'next';

const config: NextConfig = {
	reactStrictMode: true,
	transpilePackages: ['@captain/ui'],
	poweredByHeader: false
};
export default config;
