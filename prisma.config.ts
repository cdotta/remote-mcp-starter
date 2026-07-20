import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// Prisma 7 reads the datasource URL from here (it is no longer allowed in the
// schema). We load .env ourselves so the CLI picks up DATABASE_URL.
loadEnv();

export default defineConfig({
  schema: "./prisma/schema.prisma",
  migrations: {
    path: "./prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
