import User from "../models/user/user.model.js";

// ── IMPORTANT: adjust `blockedUsers` below if your User schema uses a
// different field name for the block list (e.g. `blocked`). This is the
// ONE place that needs to change — both story.controllers.js and
// config/sockets.js import this same function.
export const isBlockedEitherWay = async (userAId, userBId) => {
  if (!userAId || !userBId) return false;
  if (userAId.toString() === userBId.toString()) return false;

  const [userA, userB] = await Promise.all([
    User.findById(userAId).select("blockedUsers"),
    User.findById(userBId).select("blockedUsers"),
  ]);

  const aBlockedB = (userA?.blockedUsers || []).some((id) => id.toString() === userBId.toString());
  const bBlockedA = (userB?.blockedUsers || []).some((id) => id.toString() === userAId.toString());

  return aBlockedB || bBlockedA;
};