/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  output: 'export',
  // Static hosts often don't rewrite `/route` -> `/route.html`. Trailing slashes make refresh/bookmarks work.
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
