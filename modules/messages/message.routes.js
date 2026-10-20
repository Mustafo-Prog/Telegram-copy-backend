const { Router } = require('express');
const { requireAuth } = require('../../middlewares/auth');
const controller = require('./message.controller');

const router = Router();

router.use(requireAuth);
router.get('/', controller.list);
router.post('/', controller.create);

module.exports = router;
