const http = require("http");
const { BASE_PATH, PORT, createQuizApp, getLocalIpAddress } = require("./quiz-app");

const app = createQuizApp({ rootDir: __dirname });

const server = http.createServer(async (request, response) => {
  await app.handleRequest(request, response);
});

server.listen(PORT, "0.0.0.0", () => {
  const hostUrl = `http://localhost:${PORT}${BASE_PATH}`;
  const networkUrl = `http://${getLocalIpAddress()}:${PORT}${BASE_PATH}`;
  console.log("Quick Quiz host is running.");
  console.log(`Open locally: ${hostUrl}`);
  console.log(`Share on your Wi-Fi: ${networkUrl}`);
});
