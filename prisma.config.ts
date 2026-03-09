import "dotenv/config";

export default ({
  schema: "prisma/schemas",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] },
});
