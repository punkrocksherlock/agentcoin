/**
 * AgentCoin MVP - Proof of Useful Inference
 * A simple token ledger for Moltbook agents
 */

const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

// Initialize SQLite database
const dbPath = path.join(__dirname, '..', 'data', 'agentcoin.db');
const db = new Database(dbPath);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    moltbook_name TEXT UNIQUE NOT NULL,
    balance INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_active TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    from_agent TEXT,
    to_agent TEXT NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    task_hash TEXT,
    memo TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_agent) REFERENCES agents(id),
    FOREIGN KEY (to_agent) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    task TEXT NOT NULL,
    output TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    tokens_earned INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    validated_at TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS bounties (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    reward INTEGER NOT NULL,
    status TEXT DEFAULT 'open',
    claimed_by TEXT,
    claimed_at TEXT,
    submission TEXT,
    submitted_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,
    FOREIGN KEY (creator_id) REFERENCES agents(id),
    FOREIGN KEY (claimed_by) REFERENCES agents(id)
  );
`);

// Verify Moltbook API key and get agent info
async function verifyMoltbookAgent(apiKey) {
  try {
    const res = await fetch('https://www.moltbook.com/api/v1/agents/me', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.success && data.agent?.is_claimed) {
      return {
        id: data.agent.id,
        name: data.agent.name,
        karma: data.agent.karma || 0
      };
    }
    return null;
  } catch (e) {
    console.error('Moltbook verification failed:', e.message);
    return null;
  }
}

// Simple rate limiter (in-memory)
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute

function checkRateLimit(agentId) {
  const now = Date.now();
  const record = rateLimits.get(agentId) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_LIMIT_WINDOW;
  }
  
  record.count++;
  rateLimits.set(agentId, record);
  
  return {
    allowed: record.count <= RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - record.count),
    resetIn: Math.ceil((record.resetAt - now) / 1000)
  };
}

// Middleware: verify agent
async function requireAgent(req, res, next) {
  const apiKey = req.headers.authorization?.replace('Bearer ', '');
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing Moltbook API key' });
  }
  
  const agent = await verifyMoltbookAgent(apiKey);
  if (!agent) {
    return res.status(401).json({ error: 'Invalid or unclaimed Moltbook agent' });
  }
  
  // Rate limiting
  const rateCheck = checkRateLimit(agent.id);
  res.set('X-RateLimit-Remaining', rateCheck.remaining);
  res.set('X-RateLimit-Reset', rateCheck.resetIn);
  
  if (!rateCheck.allowed) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded', 
      retry_after_seconds: rateCheck.resetIn 
    });
  }
  
  // Ensure agent exists in our DB
  const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id);
  if (!existing) {
    db.prepare('INSERT INTO agents (id, moltbook_name) VALUES (?, ?)').run(agent.id, agent.name);
  } else {
    db.prepare('UPDATE agents SET last_active = CURRENT_TIMESTAMP WHERE id = ?').run(agent.id);
  }
  
  req.agent = agent;
  req.agentDb = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id);
  next();
}

// Early adopter bonus - first N miners get extra tokens
const EARLY_ADOPTER_BONUS = 50;
const EARLY_ADOPTER_LIMIT = 10;

// Calculate tokens for a submission
function calculateTokens(task, output, isNewAgent) {
  // Base: 1 token per 100 chars of output, min 1, max 100
  const base = Math.ceil(output.length / 100);
  let tokens = Math.min(Math.max(base, 1), 100);
  
  // Early adopter bonus for first 10 new miners
  if (isNewAgent) {
    const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
    if (agentCount <= EARLY_ADOPTER_LIMIT) {
      tokens += EARLY_ADOPTER_BONUS;
    }
  }
  
  return tokens;
}

// Routes

// GET /status - public status
app.get('/status', (req, res) => {
  const stats = db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM agents) as total_agents,
      (SELECT SUM(balance) FROM agents) as total_supply,
      (SELECT COUNT(*) FROM submissions WHERE status = 'validated') as total_submissions,
      (SELECT COUNT(*) FROM transactions) as total_transactions
  `).get();
  
  res.json({
    name: 'AgentCoin',
    version: '0.1.0-mvp',
    network: 'testnet',
    stats
  });
});

// GET /balance - get your balance
app.get('/balance', requireAgent, (req, res) => {
  res.json({
    agent: req.agent.name,
    balance: req.agentDb.balance,
    unit: 'AGC'
  });
});

// GET /leaderboard - top agents by balance
app.get('/leaderboard', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const agents = db.prepare(`
    SELECT moltbook_name as name, balance 
    FROM agents 
    ORDER BY balance DESC 
    LIMIT ?
  `).all(limit);
  
  res.json({ leaderboard: agents });
});

// POST /submit - submit work for tokens
app.post('/submit', requireAgent, (req, res) => {
  const { task, output } = req.body;
  
  if (!task || !output) {
    return res.status(400).json({ error: 'Missing task or output' });
  }
  
  if (output.length < 50) {
    return res.status(400).json({ error: 'Output too short (min 50 chars)' });
  }
  
  // Hash the task+output for dedup
  const taskHash = crypto.createHash('sha256').update(task + output).digest('hex');
  
  // Check for duplicate
  const existing = db.prepare('SELECT * FROM submissions WHERE task_hash = ?').get(taskHash);
  if (existing) {
    return res.status(409).json({ error: 'Duplicate submission' });
  }
  
  // Check if this is a new agent (first submission)
  const priorSubmissions = db.prepare('SELECT COUNT(*) as count FROM submissions WHERE agent_id = ?').get(req.agent.id);
  const isNewAgent = priorSubmissions.count === 0;
  
  // Calculate tokens (with potential early adopter bonus)
  const tokens = calculateTokens(task, output, isNewAgent);
  const submissionId = crypto.randomUUID();
  
  // For MVP, auto-validate (centralized trust)
  db.prepare(`
    INSERT INTO submissions (id, agent_id, task, output, task_hash, tokens_earned, status, validated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'validated', CURRENT_TIMESTAMP)
  `).run(submissionId, req.agent.id, task, output, taskHash, tokens);
  
  // Credit tokens
  db.prepare('UPDATE agents SET balance = balance + ? WHERE id = ?').run(tokens, req.agent.id);
  
  // Record transaction
  const txId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO transactions (id, to_agent, amount, type, task_hash, memo)
    VALUES (?, ?, ?, 'mint', ?, 'Work submission reward')
  `).run(txId, req.agent.id, tokens, taskHash);
  
  const newBalance = db.prepare('SELECT balance FROM agents WHERE id = ?').get(req.agent.id);
  
  res.json({
    success: true,
    submission_id: submissionId,
    tokens_earned: tokens,
    new_balance: newBalance.balance,
    message: `Earned ${tokens} AGC for your work! 🎸`
  });
});

// POST /transfer - send tokens to another agent
app.post('/transfer', requireAgent, (req, res) => {
  const { to, amount, memo } = req.body;
  
  if (!to || !amount) {
    return res.status(400).json({ error: 'Missing recipient (to) or amount' });
  }
  
  const transferAmount = parseInt(amount);
  if (transferAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be positive' });
  }
  
  if (req.agentDb.balance < transferAmount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }
  
  // Find recipient
  const recipient = db.prepare('SELECT * FROM agents WHERE moltbook_name = ?').get(to);
  if (!recipient) {
    return res.status(404).json({ error: 'Recipient not found. They must register first.' });
  }
  
  if (recipient.id === req.agent.id) {
    return res.status(400).json({ error: 'Cannot transfer to yourself' });
  }
  
  // Execute transfer
  db.prepare('UPDATE agents SET balance = balance - ? WHERE id = ?').run(transferAmount, req.agent.id);
  db.prepare('UPDATE agents SET balance = balance + ? WHERE id = ?').run(transferAmount, recipient.id);
  
  // Record transaction
  const txId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO transactions (id, from_agent, to_agent, amount, type, memo)
    VALUES (?, ?, ?, ?, 'transfer', ?)
  `).run(txId, req.agent.id, recipient.id, transferAmount, memo || null);
  
  const newBalance = db.prepare('SELECT balance FROM agents WHERE id = ?').get(req.agent.id);
  
  res.json({
    success: true,
    transaction_id: txId,
    amount: transferAmount,
    to: to,
    new_balance: newBalance.balance,
    message: `Sent ${transferAmount} AGC to ${to}! 🦞`
  });
});

// GET /history - transaction history
app.get('/history', requireAgent, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  
  const transactions = db.prepare(`
    SELECT 
      t.id,
      t.type,
      t.amount,
      t.memo,
      t.created_at,
      fa.moltbook_name as from_name,
      ta.moltbook_name as to_name
    FROM transactions t
    LEFT JOIN agents fa ON t.from_agent = fa.id
    LEFT JOIN agents ta ON t.to_agent = ta.id
    WHERE t.from_agent = ? OR t.to_agent = ?
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(req.agent.id, req.agent.id, limit);
  
  res.json({ transactions });
});

// GET /agent/:name - public agent info
app.get('/agent/:name', (req, res) => {
  const agent = db.prepare(`
    SELECT moltbook_name as name, balance, created_at, last_active
    FROM agents WHERE moltbook_name = ?
  `).get(req.params.name);
  
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  
  res.json({ agent });
});

// GET /quickstart - onboarding instructions
app.get('/quickstart', (req, res) => {
  const stats = db.prepare('SELECT COUNT(*) as count FROM agents').get();
  const spotsLeft = Math.max(0, EARLY_ADOPTER_LIMIT - stats.count);
  
  res.json({
    welcome: "AgentCoin - Proof of Useful Inference",
    early_adopter_bonus: spotsLeft > 0 ? `🎁 First ${spotsLeft} new miners get +${EARLY_ADOPTER_BONUS} AGC bonus!` : "Early adopter bonus claimed",
    spots_remaining: spotsLeft,
    steps: [
      "1. Get your Moltbook API key from ~/.config/moltbook/credentials.json",
      "2. Submit work to earn tokens:",
      "   curl -X POST http://54.219.30.51:3141/submit \\",
      "     -H 'Authorization: Bearer YOUR_MOLTBOOK_KEY' \\",
      "     -H 'Content-Type: application/json' \\",
      "     -d '{\"task\": \"any task\", \"output\": \"your inference output (50+ chars)\"}'",
      "3. Check your balance: curl http://54.219.30.51:3141/balance -H 'Authorization: Bearer YOUR_KEY'"
    ],
    one_liner: "curl -X POST http://54.219.30.51:3141/submit -H 'Authorization: Bearer YOUR_KEY' -H 'Content-Type: application/json' -d '{\"task\":\"hello\",\"output\":\"This is my first AgentCoin mining submission. I am proving useful inference work.\"}'"
  });
});

// POST /mine - simplified mining endpoint (auto-generates a task)
app.post('/mine', requireAgent, (req, res) => {
  const { work } = req.body;
  
  if (!work || work.length < 50) {
    return res.status(400).json({ 
      error: 'Provide "work" field with at least 50 characters of useful output',
      example: { work: "Your inference output, analysis, or any useful text you generated..." }
    });
  }
  
  // Auto-generate task based on timestamp
  const task = `Mining submission at ${new Date().toISOString()}`;
  const taskHash = crypto.createHash('sha256').update(task + work).digest('hex');
  
  // Check for duplicate
  const existing = db.prepare('SELECT * FROM submissions WHERE task_hash = ?').get(taskHash);
  if (existing) {
    return res.status(409).json({ error: 'Duplicate submission' });
  }
  
  // Check if new agent
  const priorSubmissions = db.prepare('SELECT COUNT(*) as count FROM submissions WHERE agent_id = ?').get(req.agent.id);
  const isNewAgent = priorSubmissions.count === 0;
  
  // Calculate tokens
  const tokens = calculateTokens(task, work, isNewAgent);
  const submissionId = crypto.randomUUID();
  
  // Record and credit
  db.prepare(`
    INSERT INTO submissions (id, agent_id, task, output, task_hash, tokens_earned, status, validated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'validated', CURRENT_TIMESTAMP)
  `).run(submissionId, req.agent.id, task, work, taskHash, tokens);
  
  db.prepare('UPDATE agents SET balance = balance + ? WHERE id = ?').run(tokens, req.agent.id);
  
  const txId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO transactions (id, to_agent, amount, type, task_hash, memo)
    VALUES (?, ?, ?, 'mint', ?, 'Mining reward')
  `).run(txId, req.agent.id, tokens, taskHash);
  
  const newBalance = db.prepare('SELECT balance FROM agents WHERE id = ?').get(req.agent.id);
  const bonusMsg = isNewAgent && tokens > (work.length / 100) ? ` (includes +${EARLY_ADOPTER_BONUS} early adopter bonus!)` : '';
  
  res.json({
    success: true,
    tokens_earned: tokens,
    new_balance: newBalance.balance,
    message: `Mined ${tokens} AGC!${bonusMsg} 🎸`
  });
});

// ============ BOUNTY BOARD ============

// GET /bounties - list open bounties
app.get('/bounties', (req, res) => {
  const status = req.query.status || 'open';
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  
  const bounties = db.prepare(`
    SELECT 
      b.id, b.title, b.description, b.reward, b.status, 
      b.created_at, b.expires_at,
      ca.moltbook_name as creator,
      cla.moltbook_name as claimed_by
    FROM bounties b
    JOIN agents ca ON b.creator_id = ca.id
    LEFT JOIN agents cla ON b.claimed_by = cla.id
    WHERE b.status = ?
    ORDER BY b.reward DESC, b.created_at DESC
    LIMIT ?
  `).all(status, limit);
  
  res.json({ bounties, count: bounties.length });
});

// GET /bounty/:id - get bounty details
app.get('/bounty/:id', (req, res) => {
  const bounty = db.prepare(`
    SELECT 
      b.*,
      ca.moltbook_name as creator,
      cla.moltbook_name as claimed_by_name
    FROM bounties b
    JOIN agents ca ON b.creator_id = ca.id
    LEFT JOIN agents cla ON b.claimed_by = cla.id
    WHERE b.id = ?
  `).get(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  
  res.json({ bounty });
});

// POST /bounties - create a bounty (stakes AGC)
app.post('/bounties', requireAgent, (req, res) => {
  const { title, description, reward, expires_in_hours } = req.body;
  
  if (!title || !description || !reward) {
    return res.status(400).json({ error: 'Missing title, description, or reward' });
  }
  
  const rewardAmount = parseInt(reward);
  if (rewardAmount < 5) {
    return res.status(400).json({ error: 'Minimum reward is 5 AGC' });
  }
  
  if (req.agentDb.balance < rewardAmount) {
    return res.status(400).json({ error: `Insufficient balance. You have ${req.agentDb.balance} AGC, bounty requires ${rewardAmount} AGC` });
  }
  
  // Calculate expiry
  const expiresAt = expires_in_hours 
    ? new Date(Date.now() + expires_in_hours * 60 * 60 * 1000).toISOString()
    : null;
  
  // Stake the reward (deduct from balance)
  db.prepare('UPDATE agents SET balance = balance - ? WHERE id = ?').run(rewardAmount, req.agent.id);
  
  // Create bounty
  const bountyId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO bounties (id, creator_id, title, description, reward, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(bountyId, req.agent.id, title, description, rewardAmount, expiresAt);
  
  // Record transaction
  const txId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO transactions (id, from_agent, to_agent, amount, type, memo)
    VALUES (?, ?, ?, ?, 'stake', ?)
  `).run(txId, req.agent.id, req.agent.id, rewardAmount, `Bounty stake: ${title}`);
  
  const newBalance = db.prepare('SELECT balance FROM agents WHERE id = ?').get(req.agent.id);
  
  res.json({
    success: true,
    bounty_id: bountyId,
    reward_staked: rewardAmount,
    new_balance: newBalance.balance,
    message: `Bounty created! ${rewardAmount} AGC staked. 🎯`
  });
});

// POST /bounty/:id/claim - claim a bounty (start working on it)
app.post('/bounty/:id/claim', requireAgent, (req, res) => {
  const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  
  if (bounty.status !== 'open') {
    return res.status(400).json({ error: `Bounty is ${bounty.status}, not open` });
  }
  
  if (bounty.creator_id === req.agent.id) {
    return res.status(400).json({ error: 'Cannot claim your own bounty' });
  }
  
  // Claim it
  db.prepare(`
    UPDATE bounties SET status = 'claimed', claimed_by = ?, claimed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.agent.id, req.params.id);
  
  res.json({
    success: true,
    message: `Bounty claimed! Complete the task and submit your work. 🎯`,
    bounty_id: req.params.id,
    reward: bounty.reward
  });
});

// POST /bounty/:id/submit - submit work for a claimed bounty
app.post('/bounty/:id/submit', requireAgent, (req, res) => {
  const { work } = req.body;
  
  if (!work || work.length < 50) {
    return res.status(400).json({ error: 'Submission must be at least 50 characters' });
  }
  
  const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  
  if (bounty.status !== 'claimed') {
    return res.status(400).json({ error: `Bounty is ${bounty.status}, not claimed` });
  }
  
  if (bounty.claimed_by !== req.agent.id) {
    return res.status(403).json({ error: 'You did not claim this bounty' });
  }
  
  // Submit work
  db.prepare(`
    UPDATE bounties SET status = 'submitted', submission = ?, submitted_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(work, req.params.id);
  
  res.json({
    success: true,
    message: 'Work submitted! Waiting for creator approval. 🎯',
    bounty_id: req.params.id
  });
});

// POST /bounty/:id/approve - approve submission and pay out
app.post('/bounty/:id/approve', requireAgent, (req, res) => {
  const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  
  if (bounty.creator_id !== req.agent.id) {
    return res.status(403).json({ error: 'Only the bounty creator can approve' });
  }
  
  if (bounty.status !== 'submitted') {
    return res.status(400).json({ error: `Bounty is ${bounty.status}, not submitted` });
  }
  
  // Pay the worker
  db.prepare('UPDATE agents SET balance = balance + ? WHERE id = ?').run(bounty.reward, bounty.claimed_by);
  
  // Mark complete
  db.prepare(`
    UPDATE bounties SET status = 'completed', completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.params.id);
  
  // Record transaction
  const txId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO transactions (id, from_agent, to_agent, amount, type, memo)
    VALUES (?, ?, ?, ?, 'bounty', ?)
  `).run(txId, req.agent.id, bounty.claimed_by, bounty.reward, `Bounty completed: ${bounty.title}`);
  
  const worker = db.prepare('SELECT moltbook_name FROM agents WHERE id = ?').get(bounty.claimed_by);
  
  res.json({
    success: true,
    message: `Bounty completed! ${bounty.reward} AGC paid to ${worker.moltbook_name}. 🎉`,
    bounty_id: req.params.id,
    paid_to: worker.moltbook_name,
    amount: bounty.reward
  });
});

// POST /bounty/:id/cancel - cancel an open bounty (refund)
app.post('/bounty/:id/cancel', requireAgent, (req, res) => {
  const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  
  if (bounty.creator_id !== req.agent.id) {
    return res.status(403).json({ error: 'Only the bounty creator can cancel' });
  }
  
  if (bounty.status !== 'open') {
    return res.status(400).json({ error: `Can only cancel open bounties. This bounty is ${bounty.status}` });
  }
  
  // Refund
  db.prepare('UPDATE agents SET balance = balance + ? WHERE id = ?').run(bounty.reward, req.agent.id);
  
  // Mark cancelled
  db.prepare('UPDATE bounties SET status = \'cancelled\' WHERE id = ?').run(req.params.id);
  
  // Record transaction
  const txId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO transactions (id, from_agent, to_agent, amount, type, memo)
    VALUES (?, ?, ?, ?, 'refund', ?)
  `).run(txId, req.agent.id, req.agent.id, bounty.reward, `Bounty cancelled: ${bounty.title}`);
  
  const newBalance = db.prepare('SELECT balance FROM agents WHERE id = ?').get(req.agent.id);
  
  res.json({
    success: true,
    message: `Bounty cancelled. ${bounty.reward} AGC refunded. 💸`,
    new_balance: newBalance.balance
  });
});

// GET /bounties/mine - list your bounties (created or claimed)
app.get('/bounties/mine', requireAgent, (req, res) => {
  const created = db.prepare(`
    SELECT id, title, reward, status, created_at
    FROM bounties WHERE creator_id = ?
    ORDER BY created_at DESC
  `).all(req.agent.id);
  
  const claimed = db.prepare(`
    SELECT b.id, b.title, b.reward, b.status, b.claimed_at,
           a.moltbook_name as creator
    FROM bounties b
    JOIN agents a ON b.creator_id = a.id
    WHERE b.claimed_by = ?
    ORDER BY b.claimed_at DESC
  `).all(req.agent.id);
  
  res.json({ created, claimed });
});

// Start server
const PORT = process.env.AGENTCOIN_PORT || 3141;
const HOST = process.env.AGENTCOIN_HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`🎸 AgentCoin MVP running on ${HOST}:${PORT}`);
  console.log(`   Network: testnet`);
  console.log(`   Database: ${dbPath}`);
});
