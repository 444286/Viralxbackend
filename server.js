const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'bdviral_secret_2024';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bdviral';

// Middleware
app.use('/uploads', express.static('uploads'));
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MongoDB Connection
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log('MongoDB Error:', err));

// ===== MODELS =====

// Admin Model
const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
}, { timestamps: true });
const Admin = mongoose.model('Admin', adminSchema);

// Post Model
const postSchema = new mongoose.Schema({
  title: { type: String, required: true },
  thumbnail: { type: String, required: true }, // stored filename
  link: { type: String, required: true }, // telegram/external link
  section: { 
    type: String, 
    enum: ['most_popular', 'today_new', 'trending_now'],
    required: true 
  },
  badge: { type: String, default: 'HD' }, // HD, NEW, PREMIUM etc
  isPremium: { type: Boolean, default: true },
  isNew: { type: Boolean, default: false },
  views: { type: Number, default: 0 },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
const Post = mongoose.model('Post', postSchema);

// ===== MULTER SETUP =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) return cb(null, true);
    cb(new Error('Only image files allowed'));
  }
});

// ===== AUTH MIDDLEWARE =====
const authMiddleware = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.adminId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ===== ROUTES =====

// Admin Login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });
    if (!admin) return res.status(400).json({ error: 'Invalid credentials' });
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: admin._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: admin.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Default Admin (run once)
app.post('/api/admin/setup', async (req, res) => {
  try {
    const count = await Admin.countDocuments();
    if (count > 0) return res.status(400).json({ error: 'Admin already exists' });
    const hashed = await bcrypt.hash('admin123', 10);
    const admin = new Admin({ username: 'admin', password: hashed });
    await admin.save();
    res.json({ message: 'Admin created. Username: admin, Password: admin123' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change Admin Password
app.put('/api/admin/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const admin = await Admin.findById(req.adminId);
    const isMatch = await bcrypt.compare(currentPassword, admin.password);
    if (!isMatch) return res.status(400).json({ error: 'Current password wrong' });
    admin.password = await bcrypt.hash(newPassword, 10);
    await admin.save();
    res.json({ message: 'Password updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload Thumbnail
app.post('/api/upload', authMiddleware, upload.single('thumbnail'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ 
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`
  });
});

// Get all posts (public - for frontend)
app.get('/api/posts', async (req, res) => {
  try {
    const { section } = req.query;
    const filter = { isActive: true };
    if (section) filter.section = section;
    const posts = await Post.find(filter).sort({ order: 1, createdAt: -1 });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get posts grouped by section (public)
app.get('/api/posts/grouped', async (req, res) => {
  try {
    const posts = await Post.find({ isActive: true }).sort({ order: 1, createdAt: -1 });
    const grouped = {
      most_popular: posts.filter(p => p.section === 'most_popular'),
      today_new: posts.filter(p => p.section === 'today_new'),
      trending_now: posts.filter(p => p.section === 'trending_now'),
    };
    res.json(grouped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track post click (increment views)
app.post('/api/posts/:id/click', async (req, res) => {
  try {
    await Post.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Get all posts (with inactive)
app.get('/api/admin/posts', authMiddleware, async (req, res) => {
  try {
    const { section } = req.query;
    const filter = {};
    if (section) filter.section = section;
    const posts = await Post.find(filter).sort({ order: 1, createdAt: -1 });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Create post
app.post('/api/admin/posts', authMiddleware, async (req, res) => {
  try {
    const { title, thumbnail, link, section, badge, isPremium, isNew, order } = req.body;
    const post = new Post({ title, thumbnail, link, section, badge, isPremium, isNew, order });
    await post.save();
    res.status(201).json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Update post
app.put('/api/admin/posts/:id', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Delete post
app.delete('/api/admin/posts/:id', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    // Delete thumbnail file
    const filePath = path.join(__dirname, 'uploads', post.thumbnail);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await post.deleteOne();
    res.json({ message: 'Post deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Stats
app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  try {
    const total = await Post.countDocuments();
    const active = await Post.countDocuments({ isActive: true });
    const bySection = await Post.aggregate([
      { $group: { _id: '$section', count: { $sum: 1 }, totalViews: { $sum: '$views' } } }
    ]);
    res.json({ total, active, bySection });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
