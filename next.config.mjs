/** @type {import('next').NextConfig} */
const nextConfig = {
  // Build review candidates without replacing the running workspace's .next.
  distDir: process.env.DANMAKU_NEXT_BUILD_DIR || '.next',
};

export default nextConfig;
