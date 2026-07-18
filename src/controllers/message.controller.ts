import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const getConversations = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.query;
    if (!userId) {
      res.status(400).json({ success: false, message: 'userId is required' });
      return;
    }

    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [
          { user1Id: String(userId) },
          { user2Id: String(userId) }
        ]
      },
      include: {
        user1: { select: { id: true, username: true, avatar: true, arisePoints: true } },
        user2: { select: { id: true, username: true, avatar: true, arisePoints: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    // Format conversations so the "other" user is easily accessible
    const formatted = conversations.map(c => {
      const otherUser = c.user1Id === String(userId) ? c.user2 : c.user1;
      return {
        id: c.id,
        otherUser,
        lastMessage: c.messages[0] || null,
        updatedAt: c.updatedAt
      };
    });

    res.json({ success: true, data: formatted });
  } catch (error: any) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const username = String(req.params.username);
    const currentUserId = String(req.query.currentUserId);

    if (!req.query.currentUserId || !req.params.username) {
      res.status(400).json({ success: false, message: 'currentUserId and username are required' });
      return;
    }

    const otherUser = await prisma.user.findUnique({ where: { username } });
    if (!otherUser) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // Find conversation
    const conversation = await prisma.conversation.findFirst({
      where: {
        OR: [
          { user1Id: String(currentUserId), user2Id: otherUser.id },
          { user1Id: otherUser.id, user2Id: String(currentUserId) }
        ]
      }
    });

    if (!conversation) {
      res.json({ success: true, data: [] });
      return;
    }

    // Mark messages as read
    await prisma.message.updateMany({
      where: {
        conversationId: conversation.id,
        senderId: otherUser.id,
        isRead: false
      },
      data: { isRead: true }
    });

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
      include: {
        sender: { select: { id: true, username: true, avatar: true } }
      }
    });

    res.json({ success: true, data: messages });
  } catch (error: any) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const sendMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const username = String(req.params.username);
    const senderId = String(req.body.senderId);
    const content = String(req.body.content);

    if (!req.body.senderId || !req.body.content || !req.params.username) {
      res.status(400).json({ success: false, message: 'Missing fields' });
      return;
    }

    const sender = await prisma.user.findUnique({ where: { id: senderId } });
    const receiver = await prisma.user.findUnique({ 
      where: { username },
      include: {
        followers: true,
        following: true
      }
    });

    if (!sender || !receiver) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // ENFORCE MUTUAL FOLLOW RULE (or messaging self)
    if (sender.id !== receiver.id) {
      const senderFollowsReceiver = receiver.followers.some((f: any) => f.followerId === sender.id);
      const receiverFollowsSender = receiver.following.some((f: any) => f.followingId === sender.id);

      if (!senderFollowsReceiver || !receiverFollowsSender) {
        res.status(403).json({ success: false, message: 'You can only message users who mutually follow you.' });
        return;
      }
    }

    // Find or create conversation
    let conversation = await prisma.conversation.findFirst({
      where: {
        OR: [
          { user1Id: sender.id, user2Id: receiver.id },
          { user1Id: receiver.id, user2Id: sender.id }
        ]
      }
    });

    if (!conversation) {
      // Create new
      conversation = await prisma.conversation.create({
        data: {
          user1Id: sender.id,
          user2Id: receiver.id
        }
      });
    }

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderId: sender.id,
        content
      },
      include: {
        sender: { select: { id: true, username: true, avatar: true } }
      }
    });

    // Update conversation updatedAt
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() }
    });

    res.json({ success: true, data: message });
  } catch (error: any) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
