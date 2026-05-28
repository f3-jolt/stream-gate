module.exports = {
  apps: [{
    name: 'streamgate',
    script: 'src/index.js',
    watch: false,
    env: { NODE_ENV: 'production' },
  }],
};
