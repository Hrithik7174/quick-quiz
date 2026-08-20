const path = require("path");
const { createQuizApp } = require("../quiz-app");

const app = createQuizApp({ rootDir: path.join(__dirname, "..") });

module.exports = async (request, response) => {
  await app.handleRequest(request, response);
};
