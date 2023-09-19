/*
Copyright (c) 2018 Gennadii Donchyts. All rights reserved.

This work is licensed under the terms of the MIT license.  
For a copy, see <https://opensource.org/licenses/MIT>.
*/
import ee from '@google/earthengine';

export function draw(text, pos, scale, props) {
  text = ee.String(text)
  
  var ascii = {};
  for (var i = 32; i < 128; i++) {
      ascii[String.fromCharCode(i)] = i;
  }
  ascii = ee.Dictionary(ascii);
  
  var fontSize = '16';

  if(props && props.fontSize) {
    fontSize = props.fontSize
  }
  
  var fontType = "Arial"
  if(props && props.fontType) {
    fontType = props.fontType
  }
  
  var glyphs = ee.Image('users/gena/fonts/' + fontType + fontSize);

  if(props && props.resample) {
    glyphs = glyphs.resample(props.resample)
  }
  
  var proj = glyphs.projection();
  var s = ee.Number(1).divide(proj.nominalScale())
  
  // HACK: ee.Projection does not provide a way to query xscale, yscale, determing north direction manually
  var north = ee.Algorithms.If(proj.transform().index("-1.0").gt(0), 1, -1)

  glyphs = glyphs.changeProj(proj, proj.scale(s, s.multiply(north)));
  
  // get font info
  var font = {
    height: ee.Number(glyphs.get('height')),
    width: ee.Number(glyphs.get('width')),
    cellHeight: ee.Number(glyphs.get('cell_height')),
    cellWidth: ee.Number(glyphs.get('cell_width')),
    charWidths: ee.String(glyphs.get('char_widths')).split(',').map(function (n) { return ee.Number.parse(n, 10) }),
  };
  
  font.columns = font.width.divide(font.cellWidth).floor();
  font.rows = font.height.divide(font.cellHeight).floor();
 
  function toAscii(text) {
    return ee.List(text.split('')
      .iterate(function(char, prev) { return ee.List(prev).add(ascii.get(char)); }, ee.List([])));
  }
  
  function moveChar(image, xmin, xmax, ymin, ymax, x, y) {
    var ll = ee.Image.pixelLonLat();
    var nxy = ll.floor().round().changeProj(ll.projection(), image.projection());
    var nx = nxy.select(0);
    var ny = nxy.select(1);
    var mask = nx.gte(xmin).and(nx.lt(xmax)).and(ny.gte(ymin)).and(ny.lt(ymax));
    
    return image.mask(mask).translate(ee.Number(xmin).multiply(-1).add(x), ee.Number(ymin).multiply(-1).subtract(y));
  }

  // TODO: workaround for missing chars
  text = text.replace('á', 'a')
  text = text.replace('é', 'e')
  text = text.replace('ó', 'o')

  var codes = toAscii(text);
  
  // compute width for every char
  var charWidths = codes.map(function(code) { return ee.Number(font.charWidths.get(ee.Number(code))); });

  var alignX = 0
  var alignY = 0
   
  if(props && props.alignX) {
    if(props.alignX === 'center') {
      alignX = ee.Number(charWidths.reduce(ee.Reducer.sum())).divide(2) 
    } else if(props.alignX === 'left') {
      alignX = 0 
    } else if(props.alignX === 'right') {
      alignX = ee.Number(charWidths.reduce(ee.Reducer.sum())) 
    }
  }

  if(props && props.alignY) {
    if(props.alignY === 'center') {
      alignY = ee.Number(font.cellHeight).divide(ee.Number(2).multiply(north)) 
    } else if(props.alignY === 'top') {
      alignY = 0 
    } else if(props.alignY === 'bottom') {
      alignY = ee.Number(font.cellHeight) 
    }
  }

  // compute xpos for every char
  var charX = ee.List(charWidths.iterate(function(w, list) { 
    list = ee.List(list);
    var lastX = ee.Number(list.get(-1));
    var x = lastX.add(w);
    
    return list.add(x);
  }, ee.List([0]))).slice(0, -1);
  
  var charPositions = charX.zip(ee.List.sequence(0, charX.size()));
  
  // compute char glyph positions
  var charGlyphPositions = codes.map(function(code) {
    code = ee.Number(code).subtract(32); // subtract start star (32)
    var y = code.divide(font.columns).floor().multiply(font.cellHeight);
    var x = code.mod(font.columns).multiply(font.cellWidth);
    
    return [x, y];
  });
  
  var charGlyphInfo = charGlyphPositions.zip(charWidths).zip(charPositions);
  
  pos = ee.Geometry(pos).transform(proj, scale).coordinates();
  var xpos = ee.Number(pos.get(0)).subtract(ee.Number(alignX).multiply(scale));
  var ypos = ee.Number(pos.get(1)).subtract(ee.Number(alignY).multiply(scale));

  // 'look-up' and draw char glyphs
  // var textImage = ee.ImageCollection(charGlyphInfo.map(function(o) {
  //   o = ee.List(o);
    
  //   var glyphInfo = ee.List(o.get(0));
  //   var gw = ee.Number(glyphInfo.get(1));
  //   var glyphPosition = ee.List(glyphInfo.get(0));
  //   var gx = ee.Number(glyphPosition.get(0));
  //   var gy = ee.Number(glyphPosition.get(1));
    
  //   var charPositions = ee.List(o.get(1));
  //   var x = ee.Number(charPositions.get(0));
  //   var i = ee.Number(charPositions.get(1));
    
  //   var glyph = moveChar(glyphs, gx, gx.add(gw), gy, gy.add(font.cellHeight), x, 0, proj);
  
  //   return glyph.changeProj(proj, proj.translate(xpos, ypos).scale(scale, scale));
  // })).mosaic();

  // textImage = textImage.mask(textImage)

  // >>>>>>>>>>> START WORKAROUND, 29.08.2020
  // EE backend DAG parsing logic has changed, some of map() nesting broke, 
  // ee.Geometry objects can't be used within the map() below, pass them using zip()  
  var positions = ee.List.repeat(xpos, charGlyphPositions.size()).zip(ee.List.repeat(ypos, charGlyphPositions.size()))
  charGlyphInfo = charGlyphInfo.zip(positions)

  // 'look-up' and draw char glyphs
  var charImages = ee.List(charGlyphInfo).map(function(o1) {
    o1 = ee.List(o1)
    
    var o = ee.List(o1.get(0));
    
    var xy = ee.List(o1.get(1));
    var xpos = ee.Number(xy.get(0))
    var ypos = ee.Number(xy.get(1))

    var glyphInfo = ee.List(o.get(0));
    var gw = ee.Number(glyphInfo.get(1));
    var glyphPosition = ee.List(glyphInfo.get(0));
    var gx = ee.Number(glyphPosition.get(0));
    var gy = ee.Number(glyphPosition.get(1));
    
    var charPositions = ee.List(o.get(1));
    var x = ee.Number(charPositions.get(0));
    var i = ee.Number(charPositions.get(1));
    
    var glyph = moveChar(glyphs, gx, gx.add(gw), gy, gy.add(font.cellHeight), x, 0, proj);
  
    return ee.Image(glyph).changeProj(proj, proj.translate(xpos, ypos).scale(scale, scale))
  })
  
  var textImage = ee.ImageCollection(charImages).mosaic();

  textImage = textImage.mask(textImage)
  // <<<<<<<< END WORKAROUND

  if(props) {
    props = { 
      textColor: props.textColor || 'ffffff', 
      outlineColor: props.outlineColor || '000000', 
      outlineWidth: props.outlineWidth || 0, 
      textOpacity: props.textOpacity || 0.9,
      textWidth: props.textWidth || 1, 
      outlineOpacity: props.outlineOpacity || 0.4 
    };

    var textLine = textImage
      .visualize({opacity:props.textOpacity, palette: [props.textColor], forceRgbOutput:true})
      
    if(props.textWidth > 1) {
      textLine.focal_max(props.textWidth)
    }

    if(!props || (props && !props.outlineWidth)) {
      return textLine;
    }

    var textOutline = textImage.focal_max(props.outlineWidth)
      .visualize({opacity:props.outlineOpacity, palette: [props.outlineColor], forceRgbOutput:true})

      
    return ee.ImageCollection.fromImages(ee.List([textOutline, textLine])).mosaic()
  } else {
    return textImage;
  }
}

/***
 * Annotates image, annotation info should be an array of:
 * 
 * { 
 *    position: 'left' | 'top' | 'right' | 'bottom',
 *    offset: <number>%,
 *    margin: <number>%,
 *    property: <image property name>
 *    format: <property format callback function>
 * }
 *  
 * offset is measured from left (for 'top' | 'bottom') or from top (for 'left' | 'right')
 * 
 * Example:
 * 
 * var annotations = [
 *  { 
 *    position: 'left', offset: '10%', margin: '5%',
 *    property: 'system:time_start', 
 *    format: function(o) { return ee.Date(o).format('YYYY-MM-dd') }
 *  },
 *  {
 *    position: 'top', offset: '50%', margin: '5%',
 *    property: 'SUN_AZIMUTH',
 *    format: function(o) { return ee.Number(o).format('%.1f degree') }
 *  }
 * ];
 * 
 * annotate(image, region, annotations);
 * 
 */
export function annotateImage(image, vis, bounds, annotations) {
  // generate an image for every annotation
  var imagesText = annotations.map(function(annotation) {
    annotation.format = annotation.format || function(o) { return ee.String(o) }

    var scale = annotation.scale || Map.getScale()

    var pt = getLocation(bounds, annotation.position, annotation.offset, annotation.margin, scale)
    
    if(annotation.property) {
      var str = annotation.format(image.get(annotation.property))
      
      var textProperties = { fontSize: 14, fontType: 'Arial', textColor: 'ffffff', outlineColor: '000000', outlineWidth: 2, outlineOpacity: 0.6 }

      // set custom text properties, if any
      textProperties.fontSize = annotation.fontSize || textProperties.fontSize
      textProperties.fontType = annotation.fontType || textProperties.fontType
      textProperties.textColor = annotation.textColor || textProperties.textColor
      textProperties.outlineColor = annotation.outlineColor || textProperties.outlineColor
      textProperties.outlineWidth = annotation.outlineWidth || textProperties.outlineWidth
      textProperties.outlineOpacity = annotation.outlineOpacity || textProperties.outlineOpacity

      return draw(str, pt, annotation.scale || scale, textProperties)
    } 
  })
  
  var images = [image].concat(imagesText)

  if(vis) {
      images = [image.visualize(vis)].concat(imagesText)
  }
  
  return ee.ImageCollection.fromImages(images).mosaic()
}

/***
 * Returns size of the geometry bounds
 */
export function getSize(g) {
  var p = g.projection()
  var coords = ee.List(ee.Geometry(g).bounds(1).transform(p, p.nominalScale()).coordinates().get(0))
  var ll = ee.List(coords.get(0))
  var ur = ee.List(coords.get(2))
  var ul = ee.List(coords.get(3))
  
  var height = ee.Number(ul.get(1)).subtract(ll.get(1))
  var width = ee.Number(ur.get(0)).subtract(ul.get(0))

  return { width: width, height: height }
}

/***
 * Computes a coordinate given positon as a text (left | right | top | bottom) and an offset in px or %
 */
export function getLocation(bounds, position, offset, margin, scale) {
  var coords = ee.List(ee.Geometry(bounds).bounds(scale).coordinates().get(0))
  var ll = ee.List(coords.get(0))
  var ur = ee.List(coords.get(2))
  var ul = ee.List(coords.get(3))
  
  var height = ee.Number(ul.get(1)).subtract(ll.get(1))
  var width = ee.Number(ur.get(0)).subtract(ul.get(0))

  var offsetX = 0
  var offsetY = 0
  var pt = null;

  switch(position) {
    case 'left':
      pt = ee.Geometry.Point(ul)
      offsetX = offsetToValue(margin, width)
      offsetY = offsetToValue(offset, height).multiply(-1)
      break;
    case 'right':
      pt = ee.Geometry.Point(ur)
      offsetX = offsetToValue(margin, width).multiply(-1)
      offsetY = offsetToValue(offset, height).multiply(-1)
      break;
    case 'top':
      pt = ee.Geometry.Point(ul)
      offsetX = offsetToValue(offset, width)
      offsetY = offsetToValue(margin, height).multiply(-1)
      break;
    case 'bottom':
      pt = ee.Geometry.Point(ll)
      offsetX = offsetToValue(offset, width)
      offsetY = offsetToValue(margin, height)//.multiply(-1)
      break;
  }

  return translatePoint(pt, offsetX, offsetY)
}

/***
 * Converts <number>px | <number>% to a number value. 
 */
export function offsetToValue(offset, range) {
  if(offset.match('px$')) {
    return ee.Number.parse(offset.substring(0, offset.length - 2))
  } else if(offset.match('%$')) {
    var offsetPercent = parseFloat(offset.substring(0, offset.length - 1))
    return ee.Number.parse(range).multiply(ee.Number(offsetPercent).divide(100))
  } else {
    throw 'Unknown value format: ' + offset
  }
}

export function translatePoint(pt, x, y) {
  return ee.Geometry.Point(ee.Array(pt.coordinates()).add([x,y]).toList())
}