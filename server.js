const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'bdviral_secret_2024';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bdviral';

// ===== CLOUDINARY CONFIG =====
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log('MongoDB Error:', err));

// ===== MODELS =====

const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
}, { timestamps: true });
const Admin = mongoose.model('Admin', adminSchema);

const postSchema = new mongoose.Schema({
  title:     { type: String, required: true },
  thumbnail: { type: String, required: true }, // Cloudinary full URL
  publicId:  { type: String, default: '' },    // Cloudinary public_id for deletion
  link:      { type: String, required: true },
  section: {
    type: String,
    enum: ['most_popular', 'today_new', 'trending_now'],
    required: true
  },
  badge:     { type: String, default: 'HD' },
  isPremium: { type: Boolean, default: true },
  isNew:     { type: Boolean, default: false },
  views:     { type: Number, default: 0 },
  order:     { type: Number, default: 0 },
  isActive:  { type: Boolean, default: true },
}, { timestamps: true });
const Post = mongoose.model('Post', postSchema);

// ===== MULTER + CLOUDINARY STORAGE =====
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'bdviral-thumbnails',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    transformation: [{ width: 640, height: 360, crop: 'fill', quality: 'auto' }],
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
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

// First-time admin setup
app.post('/api/admin/setup', async (req, res) => {
  try {
    const count = await Admin.countDocuments();
    if (count > 0) return res.status(400).json({ error: 'Admin already exists' });
    const hashed = await bcrypt.hash('admin123', 10);
    await new Admin({ username: 'admin', password: hashed }).save();
    res.json({ message: 'Admin created. Username: admin, Password: admin123' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change password
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

// ===== UPLOAD to Cloudinary =====
app.post('/api/upload', authMiddleware, upload.single('thumbnail'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    url:      req.file.path,       // full Cloudinary HTTPS URL — permanent
    publicId: req.file.filename,   // Cloudinary public_id for deletion later
  });
});

// ===== PUBLIC ROUTES =====

app.get('/api/posts', async (req, res) => {
  try {
    const filter = { isActive: true };
    if (req.query.section) filter.section = req.query.section;
    const posts = await Post.find(filter).sort({ order: 1, createdAt: -1 });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts/grouped', async (req, res) => {
  try {
    const posts = await Post.find({ isActive: true }).sort({ order: 1, createdAt: -1 });
    res.json({
      most_popular:  posts.filter(p => p.section === 'most_popular'),
      today_new:     posts.filter(p => p.section === 'today_new'),
      trending_now:  posts.filter(p => p.section === 'trending_now'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/:id/click', async (req, res) => {
  try {
    await Post.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ADMIN ROUTES =====

app.get('/api/admin/posts', authMiddleware, async (req, res) => {
  try {
    const filter = {};
    if (req.query.section) filter.section = req.query.section;
    const posts = await Post.find(filter).sort({ order: 1, createdAt: -1 });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/posts', authMiddleware, async (req, res) => {
  try {
    const { title, thumbnail, publicId, link, section, badge, isPremium, isNew, order } = req.body;
    const post = new Post({ title, thumbnail, publicId, link, section, badge, isPremium, isNew, order });
    await post.save();
    res.status(201).json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/posts/:id', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/posts/:id', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    // Delete from Cloudinary
    if (post.publicId) {
      try { await cloudinary.uploader.destroy(post.publicId); } catch {}
    }
    await post.deleteOne();
    res.json({ message: 'Post deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  try {
    const total  = await Post.countDocuments();
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