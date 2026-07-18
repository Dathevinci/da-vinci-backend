import app from "./app";
import { env } from "./config/env";

const PORT = env.PORT || 5000;

app.listen(PORT as number, "0.0.0.0", () => {
  console.log(`🚀 Server running in ${env.NODE_ENV} mode on port ${PORT}`);
});
