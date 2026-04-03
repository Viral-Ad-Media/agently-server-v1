'use strict';

require('dotenv').config();

const app = require('./api/index');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`\n✅ Agently backend running on http://localhost:${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/health`);
  console.log(`🔑 Auth: http://localhost:${PORT}/api/auth/login`);
  console.log(`🤖 Bootstrap: http://localhost:${PORT}/api/bootstrap\n`);
});
