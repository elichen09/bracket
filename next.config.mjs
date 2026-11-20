/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Flow, Doc flow, Split screen and Past flows were retired when the site
  // became coda: an old bookmark lands in coda itself, not on a 404.
  async redirects() {
    return ["flow", "docflow", "split", "flows"].map((s) => ({
      source: `/tools/${s}`,
      destination: "/tools/magic",
      permanent: false,
    }));
  },
};
export default nextConfig;
