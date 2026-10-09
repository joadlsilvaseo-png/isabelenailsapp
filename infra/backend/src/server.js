import http from "node:http";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool();
const PORT = Number(process.env.PORT || 3001);

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET" || req.url !== "/health") {
    res.writeHead(404);
    res.end(
      JSON.stringify({
        erro: "Rota não encontrada",
      }),
    );
    return;
  }

  try {
    await pool.query("SELECT 1");

    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "online",
        banco: "PostgreSQL conectado",
        projeto: "Isabele Nails",
      }),
    );
  } catch (erro) {
    console.error("Falha na conexão com PostgreSQL:", erro.message);

    res.writeHead(503);
    res.end(
      JSON.stringify({
        status: "erro",
        banco: "PostgreSQL indisponível",
      }),
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`API Isabele Nails iniciada na porta ${PORT}`);
});
