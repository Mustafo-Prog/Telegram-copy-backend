const { Router } = require('express');
const { requestCode, verifyCode, me } = require('../controllers/authController');
const { requireAuth } = require('../middlewares/auth');

const router = Router();

router.post('/request-code', requestCode);
router.post('/verify-code', verifyCode);
router.get('/me', requireAuth, me);

module.exports = router;
