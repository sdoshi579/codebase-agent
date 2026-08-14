/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["child_process"],
  },
};

module.exports = nextConfig;