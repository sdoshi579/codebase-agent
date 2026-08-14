/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["child_process"],
    // Required for unstable_after() in app/api/init/route.ts (Next 14.x --
    // stabilizes to a plain `after` with no flag needed in Next 15). Without
    // this, the background graphify call registered via after() is running
    // against a misconfigured/unsupported API, not the documented one.
    after: true,
  },
};

module.exports = nextConfig;