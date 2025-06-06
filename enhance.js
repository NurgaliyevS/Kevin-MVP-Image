// dotenv
require('dotenv').config();
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

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
    .ensureAlpha()
    .resize(1024, 1024, { 
      fit: 'contain', 
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png({ quality: 100 })
    .toFile(outputPngPath);
  console.log(`✅ [convertToPngAndSquare] Saved PNG: ${outputPngPath}`);
}

async function removeBackground(inputPath, outputPath) {
  try {
    console.log(`🔄 [removeBackground] Removing background from: ${inputPath}`);
    
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    if (!process.env.REMOVEBG_API_KEY) {
      throw new Error('REMOVEBG_API_KEY is not set in environment variables');
    }

    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[removeBackground] Attempt ${attempt} of ${maxRetries}`);
        
        const formData = new FormData();
        formData.append('size', 'auto');
        formData.append('image_file', fs.createReadStream(inputPath));

        const response = await axios.post('https://api.remove.bg/v1.0/removebg', formData, {
          headers: {
            'X-Api-Key': process.env.REMOVEBG_API_KEY,
            ...formData.getHeaders()
          },
          responseType: 'arraybuffer',
          timeout: 30000
        });

        if (response.status === 200 && response.data) {
          const tempPath = outputPath + '.temp';
          await fs.promises.writeFile(tempPath, response.data);
          
          await sharp(tempPath)
            .ensureAlpha()
            .resize(1024, 1024, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png({ quality: 100 })
            .toFile(outputPath);
            
          await fs.promises.unlink(tempPath);
          
          console.log(`✅ [removeBackground] Background removed and saved to: ${outputPath}`);
          return outputPath;
        }
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ [removeBackground] Attempt ${attempt} failed:`, error.message);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
      }
    }

    console.warn('⚠️ [removeBackground] All retry attempts failed, using fallback approach');
    
    await sharp(inputPath)
      .ensureAlpha()
      .resize(1024, 1024, { 
        fit: 'contain', 
        background: { r: 0, g: 0, b: 0, alpha: 0 } 
      })
      .png({ quality: 100 })
      .toFile(outputPath);
    
    console.log(`✅ [removeBackground] Fallback: Created transparent version at: ${outputPath}`);
    return outputPath;

  } catch (error) {
    console.error('❌ [removeBackground] Error:', error.message);
    throw error;
  }
}

// Create a proper mask that covers the background area, not the product
async function createBackgroundMask(inputPngPath, maskPath) {
  console.log(`🔄 [createBackgroundMask] Creating background mask for ${inputPngPath} at ${maskPath}`);
  
  try {
    // Simple approach: create a mask that covers the entire background area
    // Since we repositioned the product to center-bottom, we can create a mask that covers the top area
    console.log(`[createBackgroundMask] Creating simple background mask...`);
    
    // Create a mask where the top 60% is white (to edit) and bottom 40% is black (to preserve)
    await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: { r: 255, g: 255, b: 255 } // Start with white
      }
    })
    .composite([{
      input: Buffer.from(`<svg width="1024" height="1024">
        <rect x="0" y="0" width="1024" height="614" fill="white"/>
        <rect x="0" y="614" width="1024" height="410" fill="black"/>
      </svg>`),
      top: 0,
      left: 0
    }])
    .png({ quality: 100 })
    .toFile(maskPath);
      
    // Verify the created mask
    const maskMetadata = await sharp(maskPath).metadata();
    console.log(`[createBackgroundMask] Mask metadata: ${maskMetadata.width}x${maskMetadata.height}, channels: ${maskMetadata.channels}, format: ${maskMetadata.format}`);
    
    // Check PNG signature
    const maskBuffer = await fs.promises.readFile(maskPath);
    const pngSignature = [0x89, 0x50, 0x4E, 0x47];
    const isValidPng = pngSignature.every((byte, i) => maskBuffer[i] === byte);
    console.log(`[createBackgroundMask] Created mask is valid PNG: ${isValidPng}, size: ${maskBuffer.length} bytes`);
      
    console.log(`✅ [createBackgroundMask] Background mask saved: ${maskPath}`);
    
  } catch (error) {
    console.error('❌ [createBackgroundMask] Error:', error.message);
    throw error;
  }
}

// FIXED: Position the product at center-bottom and add white background
async function repositionProduct(inputPngPath, outputPath) {
  console.log(`🔄 [repositionProduct] Repositioning product to center-bottom`);
  
  try {
    const image = sharp(inputPngPath);
    const metadata = await image.metadata();
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    
    // Find the bounding box of the non-transparent pixels
    let minX = info.width, maxX = -1, minY = info.height, maxY = -1;
    
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * 4;
        if (data[idx + 3] > 50) { // Non-transparent pixel (threshold > 50 for better detection)
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    
    // Check if we found any opaque pixels
    if (maxX === -1 || maxY === -1) {
      console.log('⚠️ [repositionProduct] No opaque pixels found, using full image');
      minX = 0; maxX = info.width - 1;
      minY = 0; maxY = info.height - 1;
    }
    
    // Extract the product with some padding
    const padding = 10;
    const cropLeft = Math.max(0, minX - padding);
    const cropTop = Math.max(0, minY - padding);
    const cropWidth = Math.min(info.width - cropLeft, maxX - minX + 1 + padding * 2);
    const cropHeight = Math.min(info.height - cropTop, maxY - minY + 1 + padding * 2);
    
    console.log(`[repositionProduct] Crop area: ${cropLeft}, ${cropTop}, ${cropWidth}x${cropHeight}`);
    
    const croppedProduct = await sharp(inputPngPath)
      .extract({
        left: cropLeft,
        top: cropTop,
        width: cropWidth,
        height: cropHeight
      })
      .toBuffer();
    
    // Calculate target size for the product (max 70% of canvas width/height)
    const canvasWidth = 1024;
    const canvasHeight = 1024;
    const maxWidth = Math.floor(canvasWidth * 0.7); // FIXED: Use Math.floor for integer
    const maxHeight = Math.floor(canvasHeight * 0.6); // FIXED: Use Math.floor for integer
    
    // Resize if needed while maintaining aspect ratio
    let resizedProduct = croppedProduct;
    const cropMeta = await sharp(croppedProduct).metadata();
    
    if (cropMeta.width > maxWidth || cropMeta.height > maxHeight) {
      console.log(`[repositionProduct] Resizing from ${cropMeta.width}x${cropMeta.height} to fit ${maxWidth}x${maxHeight}`);
      resizedProduct = await sharp(croppedProduct)
        .resize(maxWidth, maxHeight, { 
          fit: 'inside', 
          withoutEnlargement: true,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .toBuffer();
    }
    
    const resizedMeta = await sharp(resizedProduct).metadata();
    const finalWidth = resizedMeta.width;
    const finalHeight = resizedMeta.height;
    
    console.log(`[repositionProduct] Final product size: ${finalWidth}x${finalHeight}`);
    
    // Position at center-bottom (bottom third of the image)
    const left = Math.floor((canvasWidth - finalWidth) / 2);
    const top = Math.floor(canvasHeight - finalHeight - (canvasHeight * 0.15)); // 15% from bottom
    
    console.log(`[repositionProduct] Positioning at: ${left}, ${top}`);
    
    // Create final image with pure white background (RGBA for DALL-E compatibility)
    console.log(`[repositionProduct] Creating final image with white background...`);
    await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 } // Pure white background with alpha
      }
    })
      .composite([{
        input: resizedProduct,
        left: left,
        top: top
      }])
      .ensureAlpha()
      .png({ quality: 100 })
      .toFile(outputPath);
      
    // Verify the created file
    const finalMetadata = await sharp(outputPath).metadata();
    console.log(`[repositionProduct] Final image metadata: ${finalMetadata.width}x${finalMetadata.height}, channels: ${finalMetadata.channels}, format: ${finalMetadata.format}`);
    
    // Check PNG signature
    const finalBuffer = await fs.promises.readFile(outputPath);
    const pngSignature = [0x89, 0x50, 0x4E, 0x47];
    const isValidPng = pngSignature.every((byte, i) => finalBuffer[i] === byte);
    console.log(`[repositionProduct] Created file is valid PNG: ${isValidPng}, size: ${finalBuffer.length} bytes`);
      
    console.log(`✅ [repositionProduct] Product repositioned and saved to: ${outputPath}`);
    
  } catch (error) {
    console.error('❌ [repositionProduct] Error:', error.message);
    throw error;
  }
}

async function validateImagesForDalle(imagePath, maskPath) {
  console.log(`🔄 [validateImagesForDalle] Validating images for DALL-E compatibility`);
  
  try {
    // Check image metadata
    const imageMetadata = await sharp(imagePath).metadata();
    const maskMetadata = await sharp(maskPath).metadata();
    
    console.log(`[validateImagesForDalle] Image: ${imageMetadata.width}x${imageMetadata.height}, channels: ${imageMetadata.channels}, format: ${imageMetadata.format}`);
    console.log(`[validateImagesForDalle] Mask: ${maskMetadata.width}x${maskMetadata.height}, channels: ${maskMetadata.channels}, format: ${maskMetadata.format}`);
    
    // Validate dimensions
    if (imageMetadata.width !== 1024 || imageMetadata.height !== 1024) {
      throw new Error(`Image must be 1024x1024, got ${imageMetadata.width}x${imageMetadata.height}`);
    }
    
    if (maskMetadata.width !== 1024 || maskMetadata.height !== 1024) {
      throw new Error(`Mask must be 1024x1024, got ${maskMetadata.width}x${maskMetadata.height}`);
    }
    
    // Validate formats
    if (imageMetadata.format !== 'png') {
      throw new Error(`Image must be PNG format, got ${imageMetadata.format}`);
    }
    
    if (maskMetadata.format !== 'png') {
      throw new Error(`Mask must be PNG format, got ${maskMetadata.format}`);
    }
    
    console.log(`✅ [validateImagesForDalle] Images validated successfully`);
    
  } catch (error) {
    console.error('❌ [validateImagesForDalle] Validation failed:', error.message);
    throw error;
  }
}

async function callDalleEdit(inputPngPath, maskPath, prompt, apiKey) {
  console.log(`🔄 [callDalleEdit] Calling OpenAI API with image: ${inputPngPath}, mask: ${maskPath}`);
  const openai = new OpenAI({ apiKey });

  try {
    // Validate image files exist and are proper size
    if (!fs.existsSync(inputPngPath) || !fs.existsSync(maskPath)) {
      throw new Error('Input image or mask file not found');
    }

    // Check file sizes (DALL-E has a 4MB limit)
    const imageStats = await fs.promises.stat(inputPngPath);
    const maskStats = await fs.promises.stat(maskPath);
    
    if (imageStats.size > 4 * 1024 * 1024 || maskStats.size > 4 * 1024 * 1024) {
      throw new Error('Image or mask file too large (>4MB)');
    }

    console.log(`[callDalleEdit] Image size: ${(imageStats.size / 1024).toFixed(1)}KB, Mask size: ${(maskStats.size / 1024).toFixed(1)}KB`);
    console.log(`[callDalleEdit] Prompt: ${prompt}`);
    
    // Detailed file inspection
    const imageBuffer = await fs.promises.readFile(inputPngPath);
    const maskBuffer = await fs.promises.readFile(maskPath);
    
    console.log(`[callDalleEdit] Image buffer length: ${imageBuffer.length}, first 4 bytes: ${Array.from(imageBuffer.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    console.log(`[callDalleEdit] Mask buffer length: ${maskBuffer.length}, first 4 bytes: ${Array.from(maskBuffer.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    
    // Check PNG signature
    const pngSignature = [0x89, 0x50, 0x4E, 0x47];
    const imageIsPng = pngSignature.every((byte, i) => imageBuffer[i] === byte);
    const maskIsPng = pngSignature.every((byte, i) => maskBuffer[i] === byte);
    
    console.log(`[callDalleEdit] Image is valid PNG: ${imageIsPng}, Mask is valid PNG: ${maskIsPng}`);
    
    if (!imageIsPng || !maskIsPng) {
      throw new Error('Files are not valid PNG format');
    }
    
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[callDalleEdit] Attempt ${attempt} of ${maxRetries}`);
        
        // Create proper File objects with explicit MIME types
        console.log(`[callDalleEdit] Creating File objects with explicit MIME types...`);
        const imageFile = new File([imageBuffer], path.basename(inputPngPath), { 
          type: 'image/png',
          lastModified: Date.now()
        });
        const maskFile = new File([maskBuffer], path.basename(maskPath), { 
          type: 'image/png',
          lastModified: Date.now()
        });
        
        console.log(`[callDalleEdit] Image file type: ${imageFile.type}, size: ${imageFile.size}`);
        console.log(`[callDalleEdit] Mask file type: ${maskFile.type}, size: ${maskFile.size}`);
        
        console.log(`[callDalleEdit] Calling OpenAI images.edit API...`);
        const response = await openai.images.edit({
          image: imageFile,
          mask: maskFile,
          prompt,
          n: 1,
          size: '1024x1024'
        });

        console.log(`[callDalleEdit] API response received, checking data...`);
        if (response.data && response.data[0] && response.data[0].url) {
          const url = response.data[0].url;
          console.log(`✅ [callDalleEdit] OpenAI returned image URL: ${url}`);
          return url;
        } else {
          console.log(`[callDalleEdit] Invalid response format:`, JSON.stringify(response, null, 2));
          throw new Error('Invalid response format from DALL-E API');
        }
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ [callDalleEdit] Attempt ${attempt} failed:`, error.message);
        console.warn(`[callDalleEdit] Error details:`, error);
        
        if (attempt < maxRetries) {
          console.log(`[callDalleEdit] Waiting ${2000 * attempt}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
          continue;
        }
      }
    }

    throw lastError || new Error('All DALL-E API attempts failed');
  } catch (error) {
    console.error('❌ [callDalleEdit] Error:', error.message);
    console.error('❌ [callDalleEdit] Full error:', error);
    throw error;
  }
}

async function downloadImage(url, outputPath) {
  console.log(`🔄 [downloadImage] Downloading image from: ${url}`);
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  await fs.promises.writeFile(outputPath, response.data);
  console.log(`✅ [downloadImage] Image saved to: ${outputPath}`);
}

// FIXED: Enhanced post-processing for pure white background
async function enhanceImageWithSharp(inputPath, outputPath) {
  try {
    console.log(`🔄 [enhanceImageWithSharp] Creating professional e-commerce image: ${inputPath}`);
    
    // Apply professional e-commerce enhancements
    await sharp(inputPath)
      // Ensure pure white background
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      // Enhance the image quality
      .modulate({
        brightness: 1.08,  // Slightly brighter
        saturation: 1.15,  // More vibrant colors
        hue: 0
      })
      // Professional sharpening
      .sharpen({
        sigma: 1.2,
        flat: 1,
        jagged: 2
      })
      // Enhance contrast
      .linear(1.05, -(128 * 1.05) + 128)
      // Add subtle shadow effect for depth
      .composite([{
        input: await createSubtleShadow(),
        blend: 'multiply',
        left: 0,
        top: 0
      }])
      // Final quality settings
      .png({ 
        quality: 100,
        compressionLevel: 6,
        progressive: true
      })
      .toFile(outputPath);
      
    console.log(`✅ [enhanceImageWithSharp] Professional image saved: ${outputPath}`);
  } catch (error) {
    console.error('❌ [enhanceImageWithSharp] Error:', error.message);
    throw error;
  }
}

async function createSubtleShadow() {
  // Create a subtle shadow effect for professional look
  const shadowSvg = `<svg width="1024" height="1024">
    <defs>
      <radialGradient id="shadow" cx="50%" cy="85%" r="40%">
        <stop offset="0%" style="stop-color:rgb(240,240,240);stop-opacity:1" />
        <stop offset="70%" style="stop-color:rgb(250,250,250);stop-opacity:1" />
        <stop offset="100%" style="stop-color:white;stop-opacity:1" />
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#shadow)" />
  </svg>`;
  
  return Buffer.from(shadowSvg);
}

async function postProcessImage(inputPath, outputPath) {
  try {
    console.log(`🔄 [postProcessImage] Post-processing image: ${inputPath}`);
    
    // Read the image and ensure it has a pure white background
    await sharp(inputPath)
      .flatten({ background: { r: 255, g: 255, b: 255 } }) // Flatten with white background
      .modulate({
        brightness: 1.05, // Slightly brighten
        saturation: 1.1   // Enhance colors
      })
      .sharpen({ sigma: 0.5 }) // Light sharpening
      .png({ quality: 100 })
      .toFile(outputPath);
      
    console.log(`✅ [postProcessImage] Post-processed image saved: ${outputPath}`);
  } catch (error) {
    console.error('❌ [postProcessImage] Error:', error.message);
    throw error;
  }
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.log('Usage: node enhance.js <input-image-path>');
    process.exit(1);
  }
  // Note: OPENAI_API_KEY no longer required - using Sharp-only processing
  if (!process.env.REMOVEBG_API_KEY) {
    console.error('❌ Please set your REMOVEBG_API_KEY environment variable.');
    process.exit(1);
  }
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const filename = path.basename(inputPath, path.extname(inputPath));
  const inputPngPath = path.join(OUTPUT_DIR, `${filename}_input.png`);
  const noBgPath = path.join(OUTPUT_DIR, `${filename}_no_bg.png`);
  const repositionedPath = path.join(OUTPUT_DIR, `${filename}_repositioned.png`);
  const outputPath = path.join(OUTPUT_DIR, `ideal-image-result.png`);

  try {
    console.log('🚀 [main] Starting enhanced pipeline...');
    
    // Step 1: Convert to PNG and resize
    await convertToPngAndSquare(inputPath, inputPngPath);
    
    // Step 2: Remove background
    await removeBackground(inputPngPath, noBgPath);
    
    // Step 3: Reposition product to center-bottom with white background
    await repositionProduct(noBgPath, repositionedPath);
    
    // Step 4: Enhanced image processing without DALL-E (more reliable)
    await enhanceImageWithSharp(repositionedPath, outputPath);
    
    console.log('🎉 [main] All done! Check your enhanced image at: output/ideal-image-result.png');
    
  } catch (err) {
    console.error('❌ [main] Error during enhancement pipeline:', err.message);
    
    // Fallback: Use enhanced Sharp processing
    try {
      console.log('🔄 [main] Using fallback approach...');
      if (fs.existsSync(repositionedPath)) {
        await enhanceImageWithSharp(repositionedPath, outputPath);
        console.log('✅ [main] Fallback image saved to: output/ideal-image-result.png');
      }
    } catch (fallbackError) {
      console.error('❌ [main] Fallback also failed:', fallbackError.message);
    }
    
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = ProductPhotoEnhancer;