const crypto = require("crypto");

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ""));
  const B = Buffer.from(String(b || ""));

  if (A.length !== B.length) return false;

  return crypto.timingSafeEqual(A, B);
}

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    return res.status(503).json({
      error: "Admin access is not configured."
    });
  }

  const provided =
    req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : req.headers["x-admin-password"];

  if (!safeEqual(provided, expected)) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

module.exports = {
  requireAdmin
};
