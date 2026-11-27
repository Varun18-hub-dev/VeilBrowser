// @ts-check
const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

/**
 * Development build (default): source maps, plus the content script that auto-runs on the
 * local demo site (http://localhost:3000).
 * Production build (--mode production): minified, no source maps, and the demo-only
 * content script is removed from the manifest. On real sites the script is injected only
 * after the user grants access to that site from the side panel.
 *
 * @param {unknown} _env
 * @param {{ mode?: string }} argv
 * @returns {import('webpack').Configuration}
 */
module.exports = (_env, argv) => {
  const production = argv.mode === 'production';
  return {
  mode: production ? 'production' : 'development',
  devtool: production ? false : 'inline-source-map',

  entry: {
    background: './src/background/index.ts',
    content: './src/content/index.ts',
    popup: './src/ui/popup.ts',
    sidepanel: './src/ui/sidepanel.ts',
  },

  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },

  resolve: {
    extensions: ['.ts', '.js'],
    // Resolves @veilbrowse/shared-types to the TS source directly.
    // webpack bundles it inline — no pre-compilation of shared-types needed.
    alias: {
      '@veilbrowse/shared-types': path.resolve(
        __dirname,
        '../../packages/shared-types/src/index.ts'
      ),
    },
  },

  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        // shared-types is resolved via alias (not node_modules), so ts-loader
        // will process it naturally since the path is outside node_modules.
        exclude: /node_modules/,
      },
    ],
  },

  plugins: [
    new webpack.DefinePlugin({ VEILBROWSE_CLOUD_URL: JSON.stringify(process.env.VEILBROWSE_CLOUD_URL || '') }),
    new CopyPlugin({
      patterns: [
        // Copy manifest to dist/ — Chrome loads from dist/
        {
          from: 'manifest.json',
          to: 'manifest.json',
          transform: (content) => {
            if (!production) return content;
            const manifest = JSON.parse(content.toString());
            delete manifest.content_scripts;
            return JSON.stringify(manifest, null, 2);
          },
        },
        // Copy popup HTML to dist/ — script tag references dist/popup.js
        { from: 'src/ui/popup.html', to: 'popup.html' },
        { from: 'src/ui/sidepanel.html', to: 'sidepanel.html' },
        { from: 'icons', to: 'icons' },
      ],
    }),
  ],
};
};
