import { Router } from 'express';
import { getConversations, getMessages, sendMessage } from '../controllers/message.controller';

const router = Router();

router.get('/', getConversations);
router.get('/:username', getMessages);
router.post('/:username', sendMessage);

export default router;
