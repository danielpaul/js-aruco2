/**
 * Nothing here is required to use @danielpaul/js-aruco2 — the package ships ESM
 * with an exports map, so no transpilePackages entry is needed and the worker
 * resolves through `new URL(..., import.meta.url)`.
 *
 * The headers below are only needed if you later want SharedArrayBuffer (for a
 * zero-copy frame ring instead of transferring buffers). They are scoped to the
 * scanner route because they constrain what that page can embed.
 */
const nextConfig = {
  async headers() {
    return [
      {
        source: '/scan',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ];
  },
};

export default nextConfig;
