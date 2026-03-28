/*
 * Copyright (C) 2012 Carl Hetherington <carl@carlh.net>
 * Copyright (C) 2013-2018 Paul Davis <paul@linuxaudiosystems.com>
 * Copyright (C) 2014-2017 Robin Gareus <robin@gareus.org>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */

#include <iostream>
#include <cairomm/context.h>

#include "pbd/compose.h"

#include "gtkmm2ext/utils.h"

#include "canvas/canvas.h"
#include "canvas/rectangle.h"
#include "canvas/debug.h"

using namespace std;
using namespace ArdourCanvas;

/* Rectangle notes
 *
 * A Rectangle is defined by an ArdourCanvas::Rect which encloses every pixel
 * that the Rectangle might draw. If the Rect is (0, 0, 10, 10) then a filled
 * version of the Rectangle will paint every pixel up to and including those
 * edges.
 *
 * If there is a border to the Rectangle, it will be drawn *INSIDE* the
 * boundary given by the Rect. The border will include (at minimum) the outer
 * pixel edge(s) of the Rectangle.
 *
 * This makes ArdourCanvas::Rectangle follow the semantics implied by CSS's
 * box-sizing: border-box, rather than box-sizing: content-box
 */

Rectangle::Rectangle (Canvas* c)
	: Item (c)
	, _outline_what ((What) (LEFT | RIGHT | TOP | BOTTOM))
	, _corner_radius (0.0)
{
}

Rectangle::Rectangle (Canvas* c, Rect const & rect)
	: Item (c)
	, _rect (rect)
	, _outline_what ((What) (LEFT | RIGHT | TOP | BOTTOM))
	, _corner_radius (0.0)
{
}

Rectangle::Rectangle (Item* parent)
	: Item (parent)
	, _outline_what ((What) (LEFT | RIGHT | TOP | BOTTOM))
	, _corner_radius (0.0)
{
}

Rectangle::Rectangle (Item* parent, Rect const & rect)
	: Item (parent)
	, _rect (rect)
	, _outline_what ((What) (LEFT | RIGHT | TOP | BOTTOM))
	, _corner_radius (0.0)
{
}

void
Rectangle::render (Rect const & area, Cairo::RefPtr<Cairo::Context> context) const
{
	/* Note that item_to_window() already takes _position into account (as
	   part of item_to_canvas()
	*/

	Rect self (item_to_window (_rect));
	const Rect draw = self.intersection (area);

	if (!draw) {
		return;
	}

	if (_corner_radius) {
		context->save ();
		Gtkmm2ext::rounded_rectangle (context, self.x0, self.y0, self.width(), self.height(), _corner_radius);
		context->clip ();
	}

	if (_fill && !_transparent) {
		if (_stops.empty()) {
			setup_fill_context (context);
		} else {
			setup_gradient_context (context, self, Duple (draw.x0, draw.y0));
		}

		if (_corner_radius) {
			Gtkmm2ext::rounded_rectangle (context, draw.x0, draw.y0, draw.width(), draw.height(), _corner_radius);
		} else {
			context->rectangle (draw.x0, draw.y0, draw.width(), draw.height());
		}
		context->fill ();
	}

	if (_outline && _outline_width && _outline_what) {

		setup_outline_context (context);

		Rectangle::What outline_what (_outline_what);
		Rect outline_rect (self);

		/* Our goal here is ensure that we do not pass very large
		 * (typically, > 32767) coordinates to cairo_stroke. Even if we
		 * are drawing with a clip region imposed (e.g. a the Canvas
		 * level) cairo goes bananas if told to stroke "huge"
		 * rectanges. That means both altering the coordinates used for
		 * strokes, but also potentially changing which edges of the
		 * rectangle we attempt to stroke.
		 */

		if (outline_rect.x0 < draw.x0) {
			outline_rect.x0 = draw.x0;
			outline_what = Rectangle::What (outline_what & ~Rectangle::LEFT);
		}

		if (outline_rect.x1 > draw.x1) {
			outline_rect.x1 = draw.x1;
			outline_what = Rectangle::What (outline_what & ~Rectangle::RIGHT);
		}

		if (outline_rect.y0 < draw.y0) {
			outline_rect.y0 = draw.y0;
			outline_what = Rectangle::What (outline_what & ~Rectangle::TOP);
		}

		if (outline_rect.y1 > draw.y1) {
			outline_rect.y1= draw.y1;
			outline_what = Rectangle::What (outline_what & ~Rectangle::BOTTOM);
		}

		/* Adjust to deal with cairo pixel positioning */

		const double shift = _outline_width * 0.5;
		outline_rect = outline_rect.translate (Duple (shift, shift));

		if (outline_what == ALL) {

			if (_corner_radius) {
				Gtkmm2ext::rounded_rectangle (context, outline_rect.x0, outline_rect.y0, outline_rect.width() - _outline_width, outline_rect.height() - _outline_width, _corner_radius);
			} else {
				context->rectangle (outline_rect.x0, outline_rect.y0, outline_rect.width() - _outline_width, outline_rect.height() - _outline_width);
			}

		} else {

			if (outline_what & LEFT) {
				context->move_to (outline_rect.x0, outline_rect.y0);
				context->line_to (outline_rect.x0, outline_rect.y1);
			}

			if (outline_what & TOP) {
				context->move_to (outline_rect.x0, outline_rect.y0);
				context->line_to (outline_rect.x1, outline_rect.y0);
			}

			if (outline_what & BOTTOM) {
				context->move_to (outline_rect.x0, outline_rect.y1);
				context->line_to (outline_rect.x1, outline_rect.y1);
			}

			if (outline_what & RIGHT) {
				context->move_to (outline_rect.x1, outline_rect.y0);
				context->line_to (outline_rect.x1, outline_rect.y1);
			}
		}

		context->stroke ();
	}

	if (_corner_radius) {
		context->restore ();
	}

	render_children (area, context);
}

void
Rectangle::size_request (double& w, double& h) const
{
	if (_requested_width > 0.) {
		w = _requested_width;
	} else {
		w = _rect.width();
	}

	if (_requested_height > 0.) {
		h = _requested_height;
	} else {
		h = _rect.height();
	}
}

void
Rectangle::compute_bounding_box () const
{
	if (_rect.empty ()) {
		_bounding_box = Rect ();
	} else if (_outline && _outline_width && _outline_what) {
		 _bounding_box = _rect.fix().expand (ceil (_outline_width * 0.5));
	} else {
		_bounding_box = _rect.fix();
	}

	set_bbox_clean ();
}

void
Rectangle::set (Rect const & r)
{
	/* We don't update the bounding box here; it's just
	   as cheap to do it when asked.
	*/

	if (r != _rect) {

		begin_change ();

		_rect = r;

		set_bbox_dirty ();
		end_change ();
	}
}

void
Rectangle::set_x0 (Coord x0)
{
	if (x0 != _rect.x0) {
		begin_change ();

		_rect.x0 = x0;

		set_bbox_dirty ();
		end_change ();
	}
}

void
Rectangle::set_y0 (Coord y0)
{
	if (y0 != _rect.y0) {
		begin_change ();

		_rect.y0 = y0;

		set_bbox_dirty ();
		end_change();
	}
}

void
Rectangle::set_x1 (Coord x1)
{
	if (x1 != _rect.x1) {
		begin_change ();

		_rect.x1 = x1;

		set_bbox_dirty ();
		end_change ();
	}
}

void
Rectangle::set_y1 (Coord y1)
{
	if (y1 != _rect.y1) {
		begin_change ();

		_rect.y1 = y1;

		set_bbox_dirty ();
		end_change ();
	}
}

void
Rectangle::set_outline_what (What what)
{
	if (what != _outline_what) {
		begin_visual_change ();
		_outline_what = what;
		end_visual_change ();
	}
}

double
Rectangle::vertical_fraction (double y) const
{
        /* y is in canvas coordinates */

        Duple i (canvas_to_item (Duple (0, y)));
        Rect r = bounding_box();
        if (!r) {
                return 0; /* not really correct, but what else can we do? */
        }

        Rect bbox (r);

        if (i.y < bbox.y0 || i.y >= bbox.y1) {
                return 0;
        }

        /* convert to fit Cairo origin model (origin at upper left)
         */

        return 1.0 - ((i.y - bbox.y0) / bbox.height());
}

void
Rectangle::_size_allocate (Rect const & r)
{
	Item::_size_allocate (r);

	if (_layout_sensitive) {
		/* Set _position use the upper left of the Rect, and then set
		   the _rect member with values that use _position as the
		   origin.
		*/
		Rect r2 (0, 0, r.x1 - r.x0, r.y1 - r.y0);
		set (r2);
	}
}

void
Rectangle::set_corner_radius (double r)
{
	/* note: this does not change the bounding box */

	begin_change ();
	_corner_radius = r;
	end_change ();
}

void
Rectangle::dump (std::ostream & o) const
{
	Item::dump (o);

	o << _canvas->indent() << " outline: w " << outline_width() << " color 0x" << std::hex << outline_color() << " what 0x" << _outline_what << std::dec << endl;
	o << _canvas->indent() << " fill  " << _fill << " color 0x " << std::hex << fill_color() << std::dec << endl;
}
