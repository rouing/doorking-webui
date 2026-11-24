export default {
  doorking: {
    input: '../api/docs/openapi.json',
    output: {
      target: './generated/api.ts',
      schemas: './generated/models',
      client: 'fetch',
      clean: true,
    },
  },
};
