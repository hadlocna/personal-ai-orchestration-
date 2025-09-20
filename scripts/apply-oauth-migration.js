#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function applyOAuthMigration() {
  // Load environment variables
  require('dotenv').config();

  if (!process.env.POSTGRES_URL) {
    console.error('❌ POSTGRES_URL environment variable is not set');
    console.log('Make sure to run this from the project root with a .env file');
    process.exit(1);
  }

  console.log('🔗 Connecting to database:', process.env.POSTGRES_URL.replace(/:[^:@]*@/, ':***@'));

  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false } // Required for remote databases
  });

  try {
    console.log('📡 Testing database connection...');

    // Check if table already exists
    const checkResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'oauth_tokens'
    `);

    if (checkResult.rows.length > 0) {
      console.log('✅ oauth_tokens table already exists!');
      return;
    }

    console.log('📋 Reading migration file...');
    const migrationPath = path.join(__dirname, '../infra/migrations/0003_oauth_tokens.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    console.log('🚀 Applying OAuth migration...');
    await pool.query(migrationSQL);

    console.log('✅ OAuth migration applied successfully!');
    console.log('📋 Verifying table creation...');

    const verifyResult = await pool.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'oauth_tokens'
      ORDER BY ordinal_position
    `);

    console.log('🎉 oauth_tokens table created with columns:');
    verifyResult.rows.forEach(row => {
      console.log(`   - ${row.column_name} (${row.data_type})`);
    });

  } catch (error) {
    console.error('❌ Migration failed:');
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('Full error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  applyOAuthMigration();
}