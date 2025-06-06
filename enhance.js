// dotenv
require('dotenv').config();
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { Configuration, OpenAIApi } = require('openai');
const axios = require('axios');
const OpenAI = require('openai');
const { fileFromPath } = require("openai/uploads");

const OUTPUT_DIR = './output';

class ProductPhotoEnhancer {
  constructor() {
    this.inputDir = './input';
    this.outputDir = './output';
    this.ensureDirectories();
  }

  ensureDirectories() {
    if (!fs.existsSync(this.inputDir)) {
      fs.mkdirSync(this.inputDir, { recursive: true });
    }
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async enhanceProduct(inputPath, outputPath) {
    try {
      console.log(`Processing: ${inputPath}`);
      
      // Read the original image
      const image = sharp(inputPath);
      const metadata = await image.metadata();
      
      // Create studio-quality enhancement without altering the design
      const enhanced = await image
        // Enhance contrast and brightness
        .modulate({
          brightness: 1.1,
          saturation: 1.05,
          hue: 0
        })
        // Sharpen the image for better clarity
        .sharpen({
          sigma: 1,
          flat: 1,
          jagged: 2
        })
        // Remove noise while preserving details
        .median(1)
        // Enhance colors
        .linear(1.02, -(128 * 1.02) + 128)
        // Create clean background effect
        .resize({
          width: Math.max(metadata.width, 1200),
          height: Math.max(metadata.height, 1200),
          fit: 'contain',
          background: { r: 248, g: 248, b: 248, alpha: 1 }
        })
        // Add subtle vignette for studio effect
        .composite([{
          input: await this.createVignette(Math.max(metadata.width, 1200), Math.max(metadata.height, 1200)),
          blend: 'multiply'
        }])
        // Final quality settings
        .jpeg({ quality: 95, progressive: true })
        .toBuffer();

      await fs.promises.writeFile(outputPath, enhanced);
      console.log(`✅ Enhanced: ${outputPath}`);
      
      return outputPath;
    } catch (error) {
      console.error(`❌ Error processing ${inputPath}:`, error.message);
      throw error;
    }
  }

  async createVignette(width, height) {
    // Create subtle vignette for studio lighting effect
    const vignetteBuffer = Buffer.from(
      `<svg width="${width}" height="${height}">
        <defs>
          <radialGradient id="vignette" cx="50%" cy="50%" r="70%">
            <stop offset="0%" style="stop-color:white;stop-opacity:1" />
            <stop offset="70%" style="stop-color:white;stop-opacity:1" />
            <stop offset="100%" style="stop-color:white;stop-opacity:0.95" />
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#vignette)" />
      </svg>`
    );
    
    return vignetteBuffer;
  }

  async processAllImages() {
    try {
      const files = await fs.promises.readdir(this.inputDir);
      const imageFiles = files.filter(file => 
        /\.(jpg|jpeg|png|webp)$/i.test(file)
      );

      if (imageFiles.length === 0) {
        console.log('📁 No images found in input directory');
        console.log('💡 Add your product photos to the ./input folder');
        return;
      }

      console.log(`🔄 Processing ${imageFiles.length} images...`);
      
      for (const file of imageFiles) {
        const inputPath = path.join(this.inputDir, file);
        const outputName = `enhanced_${file.replace(/\.[^/.]+$/, '')}.jpg`;
        const outputPath = path.join(this.outputDir, outputName);
        
        await this.enhanceProduct(inputPath, outputPath);
      }
      
      console.log('🎉 All images processed successfully!');
      console.log(`📁 Check the ${this.outputDir} folder for enhanced images`);
      
    } catch (error) {
      console.error('❌ Error processing images:', error.message);
    }
  }

  async enhanceSingleImage(imagePath) {
    const filename = path.basename(imagePath, path.extname(imagePath));
    const outputPath = path.join(this.outputDir, `enhanced_${filename}.jpg`);
    return await this.enhanceProduct(imagePath, outputPath);
  }
}

async function convertToPngAndSquare(inputPath, outputPngPath) {
  console.log(`🔄 [convertToPngAndSquare] Converting ${inputPath} to 1024x1024 PNG at ${outputPngPath}`);
  await sharp(inputPath)
    .resize(1024, 1024, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toFile(outputPngPath);
  console.log(`✅ [convertToPngAndSquare] Saved PNG: ${outputPngPath}`);
}

async function createWhiteMask(inputPngPath, maskPath) {
  console.log(`🔄 [createWhiteMask] Creating white mask for ${inputPngPath} at ${maskPath}`);
  await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .png()
    .toFile(maskPath);
  console.log(`✅ [createWhiteMask] White mask saved: ${maskPath}`);
}

async function callDalleEdit(inputPngPath, maskPath, prompt, apiKey) {
  console.log(`🔄 [callDalleEdit] Calling OpenAI API with image: ${inputPngPath}, mask: ${maskPath}`);
  const openai = new OpenAI({ apiKey });

  // Read files as buffers and create proper File objects
  const imageBuffer = await fs.promises.readFile(inputPngPath);
  const maskBuffer = await fs.promises.readFile(maskPath);
  
  const image = new File([imageBuffer], path.basename(inputPngPath), { type: 'image/png' });
  const mask = new File([maskBuffer], path.basename(maskPath), { type: 'image/png' });

  console.log(`[callDalleEdit] Prompt: ${prompt}`);
  const response = await openai.images.edit({
    image,
    mask,
    prompt,
    n: 1,
    size: '1024x1024',
    model: 'dall-e-2'
  });
  const url = response.data[0].url;
  console.log(`✅ [callDalleEdit] OpenAI returned image URL: ${url}`);
  return url;
}

async function downloadImage(url, outputPath) {
  console.log(`🔄 [downloadImage] Downloading image from: ${url}`);
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  await fs.promises.writeFile(outputPath, response.data);
  console.log(`✅ [downloadImage] Image saved to: ${outputPath}`);
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.log('Usage: node enhance.js <input-image-path>');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Please set your OPENAI_API_KEY environment variable.');
    process.exit(1);
  }
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const filename = path.basename(inputPath, path.extname(inputPath));
  const inputPngPath = path.join(OUTPUT_DIR, `${filename}_input.png`);
  const maskPath = path.join(OUTPUT_DIR, `${filename}_mask.png`);
  const outputPath = path.join(OUTPUT_DIR, `ideal-image.png`);
  const prompt = 'Place this product on a clean white studio background with soft lighting. Remove any other objects or background clutter.';

  try {
    console.log('🚀 [main] Starting enhancement pipeline...');
    await convertToPngAndSquare(inputPath, inputPngPath);
    await createWhiteMask(inputPngPath, maskPath);
    const url = await callDalleEdit(inputPngPath, maskPath, prompt, process.env.OPENAI_API_KEY);
    await downloadImage(url, outputPath);
    console.log('🎉 [main] All done! Check your enhanced image in the output folder as ideal-image.png');
  } catch (err) {
    console.error('❌ [main] Error during enhancement pipeline:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// Export for use as module
module.exports = ProductPhotoEnhancer;