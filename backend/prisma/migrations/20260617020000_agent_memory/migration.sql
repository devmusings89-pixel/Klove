-- Cross-session agent memory: durable per-user preferences/facts stored on the conversation row.
ALTER TABLE "AgentConversation" ADD COLUMN "memoryJson" TEXT;
