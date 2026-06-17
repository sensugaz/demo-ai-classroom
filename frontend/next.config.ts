import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server build for Docker (.next/standalone).
  output: "standalone",
  reactStrictMode: true,
};

export default nextConfig;
