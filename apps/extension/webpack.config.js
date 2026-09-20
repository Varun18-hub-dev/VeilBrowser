// @ts-check
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/** @type {import('webpack').Configuration} */
module.exports = {
  mode: 'development',
  devtool: 'inline-source-map',

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
    new CopyPlugin({
      patterns: [
        // Copy manifest to dist/ — Chrome loads from dist/
        { from: 'manifest.json', to: 'manifest.json' },
        // Copy popup HTML to dist/ — script tag references dist/popup.js
        { from: 'src/ui/popup.html', to: 'popup.html' },
        { from: 'src/ui/sidepanel.html', to: 'sidepanel.html' },
      ],
    }),
  ],
};
