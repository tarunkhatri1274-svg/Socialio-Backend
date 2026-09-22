import User from "../models/user/user.model.js";
import Notification from "../models/notifications/notification.model.js";
import { getIO, onlineUsers } from "../config/sockets.js";
import { createNotification } from "./notification.helper.js";

// ─────────────────────────────────────────────
// TOGGLE PRIVATE ACCOUNT
// ─────────────────────────────────────────────

export const togglePrivateAccount = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    user.isPrivate = !user.isPrivate;

    await user.save();

    // Emit socket event
    const io = getIO();

    io.emit("privacyChanged", {
      userId: user._id.toString(),
      isPrivate: user.isPrivate,
    });

    res.status(200).json({
      success: true,
      isPrivate: user.isPrivate,
      message: user.isPrivate
        ? "Account is now private"
        : "Account is now public",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// SEND FOLLOW REQUEST / FOLLOW USER
// ─────────────────────────────────────────────

export const sendFollowRequest = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const targetUserId = req.params.id;

    // FIX: prevent self-follow
    if (currentUserId === targetUserId) {
      return res.status(400).json({
        success: false,
        message: "You cannot follow yourself",
      });
    }

    const [currentUser, targetUser] = await Promise.all([
      User.findById(currentUserId),
      User.findById(targetUserId),
    ]);

    if (!currentUser || !targetUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // FIX: check already following
    const alreadyFollowing = targetUser.followers.some(
      (id) => id.toString() === currentUserId
    );

    if (alreadyFollowing) {
      return res.status(400).json({
        success: false,
        message: "Already following this user",
      });
    }

    // ── PUBLIC ACCOUNT ─────────────────────────────────
    if (!targetUser.isPrivate) {
      currentUser.following.push(targetUserId);
      targetUser.followers.push(currentUserId);

      await Promise.all([currentUser.save(), targetUser.save()]);

      // ← notify: started following you
      await createNotification({
        recipientId: targetUserId,
        senderId: currentUserId,
        type: "follow",
        message: `${currentUser.username} started following you`,
        link: `/profile/${currentUserId}`,
      });

      return res.status(200).json({
        success: true,
        message: "Followed successfully",
      });
    }

    // ── PRIVATE ACCOUNT ────────────────────────────────
    const requestAlreadySent = targetUser.followRequests.some(
      (id) => id.toString() === currentUserId
    );

    if (requestAlreadySent) {
      return res.status(400).json({
        success: false,
        message: "Follow request already sent",
      });
    }

    targetUser.followRequests.push(currentUserId);
    await targetUser.save();

    // ← notify: sent you a follow request
    await createNotification({
      recipientId: targetUserId,
      senderId: currentUserId,
      type: "follow_request",
      message: `${currentUser.username} sent you a follow request`,
      link: `/profile/${currentUserId}`,
    });

// ← live-tell the target's open tab(s) a new request arrived, so the
// bell dropdown refreshes immediately instead of only on next mount.
try {
  const io = getIO();
  const targetSocketId = onlineUsers.get(targetUserId.toString());

  if (targetSocketId) {
    io.to(targetSocketId).emit("newFollowRequest", {
      fromUserId: currentUserId.toString(),
    });
  }

  // Also push the authoritative updated list directly — belt and
  // suspenders in case targetSocketId lookup misses (e.g. multiple
  // tabs/devices logged in, only one registered under onlineUsers).
  const updatedTarget = await User.findById(targetUserId)
    .select("followRequests")
    .populate("followRequests", "_id username profilePic");
  io.to(`user:${targetUserId}`).emit("followRequestsList", {
    requests: updatedTarget.followRequests,
  });
} catch (e) {
  console.log("Socket emit error:", e.message);
}

res.status(200).json({
  success: true,
  message: "Follow request sent",
});
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// ACCEPT FOLLOW REQUEST
// ─────────────────────────────────────────────

export const acceptFollowRequest = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const requesterId = req.params.id;

    // FIX: prevent accepting your own request
    if (currentUserId === requesterId) {
      return res.status(400).json({
        success: false,
        message: "Invalid operation",
      });
    }

    const [currentUser, requester] = await Promise.all([
      User.findById(currentUserId),
      User.findById(requesterId),
    ]);

    if (!currentUser || !requester) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const requestExists = currentUser.followRequests.some(
      (id) => id.toString() === requesterId
    );

    // FIX: proper 404 when request doesn't exist
    if (!requestExists) {
      return res.status(404).json({
        success: false,
        message: "No follow request found from this user",
      });
    }

    // Remove from followRequests
    currentUser.followRequests = currentUser.followRequests.filter(
      (id) => id.toString() !== requesterId
    );

    // Add to followers (guard against duplicates)
    const alreadyFollower = currentUser.followers.some(
      (id) => id.toString() === requesterId
    );
    if (!alreadyFollower) {
      currentUser.followers.push(requesterId);
    }

    // Add to requester's following (guard against duplicates)
    const alreadyFollowing = requester.following.some(
      (id) => id.toString() === currentUserId
    );
    if (!alreadyFollowing) {
      requester.following.push(currentUserId);
    }

    await Promise.all([currentUser.save(), requester.save()]);

    // ← Delete the ORIGINAL "sent you a follow request" notification now
    // that it's resolved. Without this, getNotifications keeps returning
    // the same untouched follow_request notification forever (nothing
    // about it ever changes), so the Activity page would re-show
    // Confirm/Delete for an already-accepted request on every refresh —
    // same bug as the collab invite case, fixed the same way.
    await Notification.deleteMany({
      recipient: currentUserId,
      sender: requesterId,
      type: "follow_request",
    });

    // ← notify: accepted your follow request
    await createNotification({
      recipientId: requesterId,
      senderId: currentUserId,
      type: "follow_accepted",
      message: `${currentUser.username} accepted your follow request`,
      link: `/profile/${currentUserId}`,
    });

    // ← live-tell my OWN other open tabs/sessions to drop the now-
    // resolved request notification immediately, not just on next
    // refetch — mirrors collabInviteResolved for collab invites.
try {
  const io = getIO();
  const requesterSocketId = onlineUsers.get(requesterId.toString());

  // Tell the REQUESTER directly — this is what useFollowAction listens for
  // to flip their local status from "requested" to "following".
  if (requesterSocketId) {
    io.to(requesterSocketId).emit("followAccepted", {
      from: requesterId.toString(),
      toUserId: currentUserId.toString(),
    });
  }

  // Tell my OWN other tabs to drop the resolved request from the dropdown.
  io.to(`user:${currentUserId}`).emit("followRequestResolved", {
    requesterId: requesterId.toString(),
  });

  // Keep any open followers/following modals in sync for both sides.
  const updatedCurrent = await User.findById(currentUserId)
    .select("followers")
    .populate("followers", "_id username profilePic");
  io.to(`user:${currentUserId}`).emit("followersList", {
    userId: currentUserId,
    followers: updatedCurrent.followers,
  });

  const updatedRequester = await User.findById(requesterId)
    .select("following")
    .populate("following", "_id username profilePic");
  io.to(`user:${requesterId}`).emit("followingList", {
    userId: requesterId,
    following: updatedRequester.following,
  });
} catch (e) {
  console.log("Socket emit error:", e.message);
}

    res.status(200).json({
      success: true,
      message: "Follow request accepted",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// REJECT FOLLOW REQUEST
// ─────────────────────────────────────────────

export const rejectFollowRequest = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const requesterId = req.params.id;

    // FIX: prevent self-operation
    if (currentUserId === requesterId) {
      return res.status(400).json({
        success: false,
        message: "Invalid operation",
      });
    }

    const currentUser = await User.findById(currentUserId);

    if (!currentUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // FIX: verify the request actually exists before filtering
    const requestExists = currentUser.followRequests.some(
      (id) => id.toString() === requesterId
    );

    if (!requestExists) {
      return res.status(404).json({
        success: false,
        message: "No follow request found from this user",
      });
    }

    currentUser.followRequests = currentUser.followRequests.filter(
      (id) => id.toString() !== requesterId
    );

    await currentUser.save();

    // ← Delete the ORIGINAL "sent you a follow request" notification —
    // same reasoning as acceptFollowRequest above. A declined request
    // should not keep reappearing in the Activity page after a refresh.
    await Notification.deleteMany({
      recipient: currentUserId,
      sender: requesterId,
      type: "follow_request",
    });

    // ← live-tell my OWN other open tabs/sessions to drop it immediately
try {
  const io = getIO();
  const requesterSocketId = onlineUsers.get(requesterId.toString());

  // Tell the REQUESTER directly — useFollowAction's onFollowRejected
  // listens for this to clear their "requested" status.
  if (requesterSocketId) {
    io.to(requesterSocketId).emit("followRejected", {
      from: currentUserId.toString(),
    });
  }

  io.to(`user:${currentUserId}`).emit("followRequestResolved", {
    requesterId: requesterId.toString(),
  });
} catch (e) {
  console.log("Socket emit error:", e.message);
}

    res.status(200).json({
      success: true,
      message: "Follow request rejected",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// CANCEL FOLLOW REQUEST
// ─────────────────────────────────────────────

export const cancelFollowRequest = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const targetUserId = req.params.id;

    // FIX: prevent self-operation
    if (currentUserId === targetUserId) {
      return res.status(400).json({
        success: false,
        message: "You cannot cancel a request to yourself",
      });
    }

    const targetUser = await User.findById(targetUserId);

    if (!targetUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // FIX: verify the pending request actually exists
    const requestExists = targetUser.followRequests.some(
      (id) => id.toString() === currentUserId
    );

    if (!requestExists) {
      return res.status(404).json({
        success: false,
        message: "No pending follow request found",
      });
    }

    targetUser.followRequests = targetUser.followRequests.filter(
      (id) => id.toString() !== currentUserId
    );

    await targetUser.save();

    // ← I (the requester) cancelled my own pending request — delete the
    // notification I originally sent to the target, so it doesn't sit
    // in their Activity page forever for a request that no longer exists.
    await Notification.deleteMany({
      recipient: targetUserId,
      sender: currentUserId,
      type: "follow_request",
    });

    try {
      const io = getIO();
      io.to(`user:${targetUserId}`).emit("followRequestResolved", {
        requesterId: currentUserId.toString(),
      });
    } catch (e) {
      console.log("Socket emit error:", e.message);
    }

    res.status(200).json({
      success: true,
      message: "Follow request cancelled",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// UNFOLLOW USER
// ─────────────────────────────────────────────

export const unfollowUser = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const targetUserId = req.params.id;

    if (currentUserId === targetUserId) {
      return res.status(400).json({
        success: false,
        message: "You cannot unfollow yourself",
      });
    }

    const [currentUser, targetUser] = await Promise.all([
      User.findById(currentUserId),
      User.findById(targetUserId),
    ]);

    if (!currentUser || !targetUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // FIX: verify actually following before unfollowing
    const isFollowing = targetUser.followers.some(
      (id) => id.toString() === currentUserId
    );

    if (!isFollowing) {
      return res.status(400).json({
        success: false,
        message: "You are not following this user",
      });
    }

    currentUser.following = currentUser.following.filter(
      (id) => id.toString() !== targetUserId
    );

    targetUser.followers = targetUser.followers.filter(
      (id) => id.toString() !== currentUserId
    );

await Promise.all([currentUser.save(), targetUser.save()]);

try {
  const io = getIO();

  io.to(`user:${targetUserId}`).emit("userUnfollowed", {
    fromUserId: currentUserId.toString(),
    toUserId: targetUserId.toString(),
  });

  const updatedTarget = await User.findById(targetUserId)
    .select("followers")
    .populate("followers", "_id username profilePic");
  io.to(`user:${targetUserId}`).emit("followersList", {
    userId: targetUserId.toString(),
    followers: updatedTarget.followers,
  });

  const updatedCurrent = await User.findById(currentUserId)
    .select("following")
    .populate("following", "_id username profilePic");
  io.to(`user:${currentUserId}`).emit("followingList", {
    userId: currentUserId.toString(),
    following: updatedCurrent.following,
  });
} catch (e) {
  console.log("Socket emit error:", e.message);
}

res.status(200).json({
  success: true,
  message: "Unfollowed successfully",
});
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// REMOVE FOLLOWER
// ─────────────────────────────────────────────

export const removeFollower = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const followerId = req.params.id;

    // FIX: prevent self-operation
    if (currentUserId === followerId) {
      return res.status(400).json({
        success: false,
        message: "Invalid operation",
      });
    }

    const [currentUser, follower] = await Promise.all([
      User.findById(currentUserId),
      User.findById(followerId),
    ]);

    if (!currentUser || !follower) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // FIX: verify the person is actually a follower
    const isFollower = currentUser.followers.some(
      (id) => id.toString() === followerId
    );

    if (!isFollower) {
      return res.status(400).json({
        success: false,
        message: "This user is not your follower",
      });
    }

    currentUser.followers = currentUser.followers.filter(
      (id) => id.toString() !== followerId
    );

    follower.following = follower.following.filter(
      (id) => id.toString() !== currentUserId
    );

await Promise.all([currentUser.save(), follower.save()]);

try {
  const io = getIO();
  io.to(`user:${followerId}`).emit("userUnfollowed", {
    fromUserId: followerId.toString(),
    toUserId: currentUserId.toString(),
  });

  const updatedCurrent = await User.findById(currentUserId)
    .select("followers")
    .populate("followers", "_id username profilePic");
  io.to(`user:${currentUserId}`).emit("followersList", {
    userId: currentUserId.toString(),
    followers: updatedCurrent.followers,
  });

  const updatedFollower = await User.findById(followerId)
    .select("following")
    .populate("following", "_id username profilePic");
  io.to(`user:${followerId}`).emit("followingList", {
    userId: followerId.toString(),
    following: updatedFollower.following,
  });
} catch (e) {
  console.log("Socket emit error:", e.message);
}

res.status(200).json({
  success: true,
  message: "Follower removed",
});
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// CHECK PRIVATE ACCOUNT ACCESS (Middleware)
// ─────────────────────────────────────────────

export const checkPrivateAccount = async (req, res, next) => {
  try {
    const profileUserId = req.params.id;
    const currentUserId = req.user.id;

    const profileUser = await User.findById(profileUserId);

    if (!profileUser) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Public account — allow
    if (!profileUser.isPrivate) return next();

    // Own profile — allow
    if (profileUserId === currentUserId) return next();

    // Check if current user is a follower
    const isFollower = profileUser.followers.some(
      (id) => id.toString() === currentUserId
    );

    if (!isFollower) {
      return res.status(403).json({
        success: false,
        message: "This account is private",
      });
    }

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}; 