const { Router } = require('express');
const { listMessages, createMessage } = require('../controllers/messageController');
const { requireAuth } = require('../middlewares/auth');

const router = Router();

router.use(requireAuth);
router.get('/', listMessages);
router.post('/', createMessage);

module.exports = router;
