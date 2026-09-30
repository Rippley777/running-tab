import {pool} from '../server/db/index.js';
if(process.env.DEMO_ENABLED!=='true'||process.env.NODE_ENV==='production'||process.env.CONFIRM_RESET!=='runningtab-local')throw new Error('Reset requires DEMO_ENABLED=true and CONFIRM_RESET=runningtab-local. It destroys the configured development database.');
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await pool.end();console.log('Development schema reset. Run db:migrate and db:seed.');
