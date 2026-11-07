/** @type {import('next').NextConfig} */
const nextConfig = {
  // The runner assigns an isolated directory for dev and candidate builds.
  // Keep the environment override for deployment and independent validation.
  distDir: process.env.DANMAKU_NEXT_BUILD_DIR || '.next',
};

export default nextConfig;
